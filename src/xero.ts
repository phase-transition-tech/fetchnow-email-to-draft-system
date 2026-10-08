import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { DraftBillInput, DraftBillResult, XeroAdapter } from './types.js';
import { getValidToken, refreshToken } from './xero/oauth.js';

/** 测试与验收用：mock 适配器每次建单都会记一笔，用来断言「同一邮件不重复建单」 */
export const mockCallLog: DraftBillInput[] = [];

export function resetMockCallLog(): void {
  mockCallLog.length = 0;
}

export function getMockCallLog(): readonly DraftBillInput[] {
  return mockCallLog;
}

export function createAdapter(cfg: Config): XeroAdapter {
  return cfg.xero.provider === 'xero' ? new XeroApiAdapter(cfg) : new MockXeroAdapter(cfg);
}

export class MockXeroAdapter implements XeroAdapter {
  readonly name = 'mock';

  constructor(private readonly cfg: Config) {}

  async createDraftBill(input: DraftBillInput): Promise<DraftBillResult> {
    const dir = this.cfg.storage.draftsDir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 终态一定是草稿：mock 里也只写 status=DRAFT，不提供任何批准动作
    const bill = {
      provider: 'mock',
      status: 'DRAFT',
      Type: 'ACCPAY',
      ...input,
      createdAt: new Date().toISOString(),
    };
    const id = `mock-${Date.now().toString(36)}-${input.attachmentFilename.slice(0, 4)}`;
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(bill, null, 2));
    mockCallLog.push(input);
    return { provider: 'mock', billId: id, status: 'DRAFT' };
  }
}

/** 限流是「可以重试」的错：worker 看到它就该退避，而不是直接判死 */
export class XeroRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec: number | null,
    readonly limitKind: 'application' | 'tenant',
  ) {
    super(message);
    this.name = 'XeroRateLimitError';
  }
}

export class XeroApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorNumber?: string,
  ) {
    super(message);
    this.name = 'XeroApiError';
  }
}

const isAuthError = (err: unknown): boolean =>
  err instanceof XeroApiError && (err.status === 401 || err.status === 403);

const isRateLimitError = (err: unknown): boolean => err instanceof XeroRateLimitError;

export const isRetryableXeroError = (err: unknown): boolean => isRateLimitError(err);

function tenantId(): string {
  const id = process.env.XERO_TENANT_ID;
  if (!id) throw new XeroApiError('真 Xero 调用需要 XERO_TENANT_ID（OAuth 授权完成后从连接页拿）', 0);
  return id;
}

function requireTenantHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Xero-Tenant-Id': tenantId(), Accept: 'application/json' };
}

/** Xero 的错误体是 {ErrorNumber, Description}，直接把 status 抛出去人看不懂是限流还是字段错 */
async function readError(res: Response): Promise<never> {
  let errorNumber: string | undefined;
  let description = `${res.status} ${res.statusText}`;
  try {
    const text = await res.text();
    const json = JSON.parse(text) as { ErrorNumber?: string; Description?: string };
    if (json.ErrorNumber) errorNumber = String(json.ErrorNumber);
    if (json.Description) description = String(json.Description);
  } catch {
    /* 非 JSON 错误体沿用 status */
  }
  if (res.status === 429) {
    const resetRaw = res.headers.get('x-rate-limit-reset') ?? res.headers.get('retry-after');
    const kind = res.headers.get('x-rate-limit-type') === 'Tenant' ? 'tenant' : 'application';
    const resetSec = resetRaw ? Math.max(0, Number(resetRaw) - Math.floor(Date.now() / 1000)) : null;
    throw new XeroRateLimitError(`Xero 限流（${kind}）：${description}`, Number.isFinite(resetSec) ? resetSec : null, kind);
  }
  throw new XeroApiError(`Xero 请求失败：${description}`, res.status, errorNumber);
}

/**
 * 真 Xero：端点与字段形状已核对过（POST /api/v3.0/Invoices，Type ACCPAY，
 * 不传 Status 默认就是 DRAFT），OAuth2 的 code/refresh 轮换放在 ./xero/oauth.ts。
 *
 * 这里四件事是真实的坑，都单独处理了：
 * 1. 建单前先按发票号 GET 查一次——网络抖动导致的「POST 超时以为失败、重试又建一单」，
 *    是唯一能绕过我们数据库幂等的重复账单路径；
 * 2. 附件必须在建单**之后**单独 PUT 原始字节流，不能塞在 JSON 里；
 * 3. 401 不要立刻判死，refresh 一次再重试（只重试一次，防 refresh 死循环）；
 * 4. 429 要识别成可重试错误并把 Retry-After 交给 worker 退避。
 */
export class XeroApiAdapter implements XeroAdapter {
  readonly name = 'xero';

  constructor(private readonly cfg: Config) {}

  async createDraftBill(input: DraftBillInput): Promise<DraftBillResult> {
    return this.withAuthRetry(async (token) => {
      if (this.cfg.xero.checkExisting) {
        const hit = await this.findExisting(token, input.invoiceNo);
        if (hit) {
          return { provider: 'xero', billId: hit.InvoiceID, status: hit.Status ?? 'DRAFT', url: urlOf(hit.InvoiceID), deduped: true };
        }
      }
      const invoice = await this.postInvoice(token, input);
      await this.putAttachment(token, invoice.InvoiceID, input);
      return { provider: 'xero', billId: invoice.InvoiceID, status: invoice.Status ?? 'DRAFT', url: urlOf(invoice.InvoiceID) };
    });
  }

  /** 只有一次 refresh 机会：refresh 后又 401 说明 refresh_token 也废了，让它进死信等人工重新授权 */
  private async withAuthRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    let token = (await getValidToken(this.cfg)).accessToken;
    try {
      return await fn(token);
    } catch (err) {
      if (!isAuthError(err)) throw err;
      token = (await refreshToken(this.cfg)).accessToken;
      return fn(token);
    }
  }

  private async findExisting(token: string, invoiceNo: string): Promise<{ InvoiceID: string; Status?: string } | null> {
    try {
      const url = new URL(`${this.baseUrl}/Invoices`);
      url.searchParams.set('InvoiceNumber', invoiceNo);
      url.searchParams.set('Where', 'Type=="ACCPAY"');
      const res = await fetch(url, { headers: requireTenantHeader(token) });
      if (!res.ok) {
        // 401 要往上抛（触发 refresh 重试）；其他失败只当「没查到」，不让票卡住
        if (res.status === 401 || res.status === 403) throw new XeroApiError('查重时鉴权失败', res.status);
        return null;
      }
      const json = (await res.json()) as { Invoices?: { InvoiceID?: string; Status?: string }[] };
      const first = json.Invoices?.[0];
      return first?.InvoiceID ? { InvoiceID: first.InvoiceID, Status: first.Status } : null;
    } catch (err) {
      if (err instanceof XeroApiError) throw err;
      return null;
    }
  }

  private async postInvoice(token: string, input: DraftBillInput): Promise<{ InvoiceID: string; Status?: string }> {
    const body = {
      Invoices: [
        {
          Type: 'ACCPAY',
          Contact: { Name: input.vendor },
          // 供应商发票默认含税，Xero 默认是 Exclusive，不显式给就全错
          LineAmountTypes: this.cfg.xero.lineAmountTypes,
          InvoiceNumber: input.invoiceNo,
          // 引用里带邮件 message-id，事后对账能一路追回原邮件
          Reference: `email:${input.sourceMessageId}`,
          Date: input.issueDate,
          DueDate: input.dueDate ?? undefined,
          CurrencyCode: input.currency,
          Status: 'DRAFT',
          LineItems: input.lineItems.map((li) => ({
            Description: li.description,
            Quantity: li.quantity,
            UnitAmount: li.unitAmount,
            AccountCode: this.cfg.xero.defaultAccountCode,
            TaxType: this.cfg.xero.defaultTaxCode,
            LineAmount: li.lineAmount,
          })),
          Total: input.total,
        },
      ],
    };

    const res = await fetch(`${this.baseUrl}/Invoices`, {
      method: 'POST',
      headers: { ...requireTenantHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await readError(res);
    const json = (await res.json()) as { Invoices?: { InvoiceID?: string; Status?: string }[] };
    const invoice = json.Invoices?.[0];
    if (!invoice?.InvoiceID) throw new XeroApiError('Xero 没返回 InvoiceID', res.status);
    return { InvoiceID: invoice.InvoiceID, Status: invoice.Status };
  }

  private async putAttachment(token: string, invoiceId: string, input: DraftBillInput): Promise<void> {
    const filename = encodeURIComponent(input.attachmentFilename);
    const res = await fetch(`${this.baseUrl}/Invoices/${invoiceId}/Attachments/${filename}`, {
      method: 'PUT',
      headers: { ...requireTenantHeader(token), 'Content-Type': input.attachmentContentType ?? 'application/pdf' },
      body: readFileSync(input.attachmentPath),
    });
    if (!res.ok) await readError(res);
  }

  /** 只读探活：`xero check` 用，确认 token/scope/tenant 三者对得上 */
  async probe(): Promise<{ orgName: string; status: string }> {
    return this.withAuthRetry(async (token) => {
      const res = await fetch(`${this.baseUrl}/Organisation`, { headers: requireTenantHeader(token) });
      if (!res.ok) await readError(res);
      const json = (await res.json()) as { Organisations?: { Name?: string }[] };
      return { orgName: json.Organisations?.[0]?.Name ?? '(未知组织)', status: 'OK' };
    });
  }

  private get baseUrl(): string {
    return this.cfg.xero.baseUrl.replace(/\/+$/, '');
  }
}

function urlOf(invoiceId: string): string {
  return `https://app.xero.com/app/managing/workinprogress/invoice/${invoiceId}`;
}
