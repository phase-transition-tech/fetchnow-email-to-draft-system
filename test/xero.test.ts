import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig, resolvePaths } from '../src/config.js';
import { admitInvoice, ingestOnce, processOnce } from '../src/pipeline.js';
import { getInvoice, listInvoices, open } from '../src/db.js';
import type { DraftBillInput } from '../src/types.js';
import { XeroApiAdapter, XeroRateLimitError } from '../src/xero.js';
import { saveToken } from '../src/xero/oauth.js';
import { startFakeXero, type FakeXeroHandle } from '../scripts/fake-xero.mjs';
import { buildPdfText, writeFixtures } from '../scripts/make-fixtures.mjs';

/**
 * 阶段二的验收：不发真请求，但**请求体形状必须是真的**——
 * 字段拼错、附件传错地方、限流被当成失败，这些只有在真 Xero 上才会暴露成重复账单或静默错账，
 * 所以这里用一个只认端点形状的假服务把它们提前拦住。
 */
describe('Xero 真接口适配器（对打本地假 Xero）', () => {
  let server: FakeXeroHandle;
  let tmp: string;
  let pdfPath: string;
  let cfg: ReturnType<typeof loadConfig>;

  before(async () => {
    server = await startFakeXero();
    tmp = mkdtempSync(path.join(tmpdir(), 'xero-test-'));
    pdfPath = path.join(tmp, 'INV-2026-0912.pdf');
    writeFileSync(pdfPath, buildPdfText(['Southwind Trading Ltd', 'INV-2026-0912', 'Total 3150.00']));
    process.env.XERO_TENANT_ID = 'test-tenant';
    process.env.XERO_CLIENT_ID = 'test-client';
    process.env.XERO_CLIENT_SECRET = 'test-secret';
    cfg = loadConfig({
      xero: {
        provider: 'xero',
        baseUrl: server.baseUrl,
        tokenUrl: server.tokenUrl,
        tokenPath: path.join(tmp, 'token.json'),
        checkExisting: true,
      },
      storage: { dir: path.join(tmp, 'data') },
    });
    saveToken(cfg, {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      obtainedAt: new Date().toISOString(),
    });
  });

  after(async () => {
    await server.close();
  });

  const input = (): DraftBillInput => ({
    vendor: 'Southwind Trading Ltd',
    invoiceNo: 'INV-2026-0912',
    issueDate: '2026-09-12',
    dueDate: '2026-10-12',
    currency: 'NZD',
    lineAmountTypes: 'Inclusive',
    lineItems: [
      { description: 'Widget A', quantity: 2, unitAmount: 1500, lineAmount: 3000 },
      { description: 'Freight', quantity: 1, unitAmount: 150, lineAmount: 150 },
    ],
    tax: 157.5,
    total: 3157.5,
    taxCode: 'INPUT',
    accountCode: '600',
    attachmentPath: pdfPath,
    attachmentFilename: 'INV-2026-0912.pdf',
    sourceMessageId: '<abc@mail.example>',
  });

  const countPost = () =>
    server.state.calls.filter((c) => c.method === 'POST' && (c.path === '/Invoices' || c.path === '/api/v3.0/Invoices')).length;

  it('建单请求体形状正确，且附件走建单之后的单独 PUT（原始字节）', async () => {
    const adapter = new XeroApiAdapter(cfg);
    const res = await adapter.createDraftBill(input());

    assert.equal(res.status, 'DRAFT');
    assert.equal(res.deduped, undefined);

    // 假服务记下的 body 就是 POST /Invoices 里的那一个对象
    const post = server.state.calls.find((c) => c.method === 'POST') as { body: Record<string, unknown> };
    const invoice = post.body;
    assert.equal(invoice.Type, 'ACCPAY');
    assert.equal(invoice.Status, 'DRAFT');
    // Xero 默认 Exclusive，供应商发票不显式给就会全错
    assert.equal(invoice.LineAmountTypes, 'Inclusive');
    assert.equal((invoice.Contact as { Name: string }).Name, 'Southwind Trading Ltd');
    assert.equal(invoice.InvoiceNumber, 'INV-2026-0912');
    assert.equal(invoice.CurrencyCode, 'NZD');
    assert.equal(invoice.DueDate, '2026-10-12');
    assert.equal((invoice.LineItems as unknown[]).length, 2);
    assert.match(String(invoice.Reference), /^email:<abc@mail\.example>$/);
    assert.match(String((invoice.LineItems as Record<string, string>[]).at(0)?.TaxType), /INPUT/);

    const put = server.state.calls.find((c) => c.method === 'PUT') as { bytes: number; contentType: string; filename: string };
    assert.equal(server.state.attachments[0]!.contentType, 'application/pdf');
    // 传的是原始字节流，不是 JSON、也不是 base64：长度必须和磁盘上的 PDF 一模一样
    assert.equal(put.bytes, statSync(pdfPath).size);
    assert.equal(put.filename, 'INV-2026-0912.pdf');
    assert.equal(server.state.attachments.length, 1);
  });

  it('同发票号已建过单时复用 InvoiceID，不再发第二个 POST', async () => {
    server.reset();
    const adapter = new XeroApiAdapter(cfg);
    const first = await adapter.createDraftBill(input());
    assert.equal(countPost(), 1);

    // 模拟「网络超时以为失败、人工又点了一次重推」：库里没有 provider_ref 时会再次调用适配器
    const second = await adapter.createDraftBill(input());
    assert.equal(second.deduped, true);
    assert.equal(second.billId, first.billId);
    assert.equal(countPost(), 1, '查重命中后不得重复 POST');
    assert.equal(server.state.attachments.length, 1, '已存在的草稿不该重复传附件');
  });

  it('401 触发一次 token 轮换后重试，不判死', async () => {
    server.close();
    server = await startFakeXero({ firstCallUnauthorized: true });
    cfg.xero.baseUrl = server.baseUrl;
    cfg.xero.tokenUrl = server.tokenUrl;

    const adapter = new XeroApiAdapter(cfg);
    const res = await adapter.createDraftBill(input());

    assert.equal(res.status, 'DRAFT');
    assert.equal(server.state.tokenCalls, 1, '应该换了一次 token');
    assert.equal(server.state.unauthorizedUsed, 1);
    const posts = server.state.calls.filter((c) => c.method === 'POST' && c.path === '/Invoices') as { auth: string }[];
    assert.equal(posts.length, 2);
    assert.match(posts[1]!.auth, /^Bearer new-access-1$/, '重试必须带着新 token');
  });

  it('429 被识别成可重试错误，并带上 Retry-After 而不是判死', async () => {
    server.close();
    server = await startFakeXero({ rateLimitOnce: 1 });
    cfg.xero.baseUrl = server.baseUrl;

    const adapter = new XeroApiAdapter(cfg);
    const err = await adapter.createDraftBill(input()).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof XeroRateLimitError, '限流必须是专门的异常类型');
    assert.equal(countPost(), 1);
    assert.equal(server.state.attachments.length, 0, '限流不该已经把附件传上去');
  });

  it('access token 快过期时先轮换再建单', async () => {
    server.close();
    server = await startFakeXero();
    cfg.xero.baseUrl = server.baseUrl;
    cfg.xero.tokenUrl = server.tokenUrl;
    // 5 分钟后就过期，早于默认的 300s 提前量 → 应该先换
    saveToken(cfg, {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      obtainedAt: new Date().toISOString(),
    });

    const adapter = new XeroApiAdapter(cfg);
    await adapter.createDraftBill(input());

    assert.equal(server.state.tokenCalls, 1, '过期就该先换 token');
    const posts = server.state.calls.filter((c) => c.method === 'POST' && c.path === '/Invoices') as { auth: string }[];
    assert.match(posts[0]!.auth, /^Bearer new-access-1$/);
  });
});

/**
 * 把阶段二接进来之后，**整条流水线**仍然只打一次真接口。
 * 这条用例防的是最贵的一类事故：数据库里的 provider_ref 丢了（备份回滚、手工改库），
 * 任务重推时又 POST 一次，Xero 里就躺了两张一模一样的草稿。
 */
describe('阶段二端到端：流水线打到真接口形状', () => {
  let server: FakeXeroHandle;
  let cfg: ReturnType<typeof loadConfig>;

  before(async () => {
    server = await startFakeXero();
    const tmp = mkdtempSync(path.join(tmpdir(), 'xero-e2e-'));
    const inbox = path.join(tmp, 'inbox');
    writeFixtures(inbox);
    process.env.XERO_TENANT_ID = 'test-tenant';
    process.env.XERO_CLIENT_ID = 'test-client';
    process.env.XERO_CLIENT_SECRET = 'test-secret';
    cfg = resolvePaths(
      loadConfig({
        ingest: { mode: 'folder', folder: { path: inbox } },
        storage: { dir: path.join(tmp, 'data') },
        xero: {
          provider: 'xero',
          baseUrl: server.baseUrl,
          tokenUrl: server.tokenUrl,
          tokenPath: path.join(tmp, 'token.json'),
          checkExisting: true,
        },
      }),
    );
    saveToken(cfg, {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      obtainedAt: new Date().toISOString(),
    });
  });

  after(async () => {
    await server.close();
  });

  const postCount = () => server.state.calls.filter((c) => c.method === 'POST' && (c.path === '/Invoices' || c.path === '/api/v3.0/Invoices')).length;

  it('pipeline 走真接口适配器：一个草稿、一次 POST，provider_ref 丢失后重推仍不重复建单', async () => {
    const handle = open(cfg);
    try {
      await ingestOnce(handle);
      for (const r of listInvoices(handle.db, 'observed')) admitInvoice(handle, Number(r.id));

      const adapter = new XeroApiAdapter(cfg);
      for (let i = 0; i < 10; i += 1) {
        const s = await processOnce(handle, { adapter });
        if (s.processed === 0) break;
      }

      const created = listInvoices(handle.db, 'created');
      assert.equal(created.length, 1, '只有金额自洽的那张票会建单');
      assert.equal(created[0]!.provider, 'xero');
      assert.match(String(created[0]!.provider_ref), /^[0-9a-f-]{36}$/, 'provider_ref 应是真接口返回的 InvoiceID');
      assert.equal(postCount(), 1);

      // 模拟 provider_ref 丢失（手工改库 / 备份回灌）后重推
      handle.db
        .prepare("UPDATE invoices SET status = 'admitted', provider_ref = NULL, attempt_count = 0, last_error = NULL WHERE id = ?")
        .run(Number(created[0]!.id));

      for (let i = 0; i < 10; i += 1) {
        const s = await processOnce(handle, { adapter });
        if (s.processed === 0) break;
      }
      assert.equal(postCount(), 1, '真接口查重必须挡住第二次 POST，Xero 里不能出现两张同发票号的草稿');
      const after = getInvoice(handle.db, Number(created[0]!.id));
      assert.equal(after?.status, 'created');
      assert.match(String(after?.provider_ref), /^[0-9a-f-]{36}$/);
    } finally {
      handle.db.close();
    }
  });
});
