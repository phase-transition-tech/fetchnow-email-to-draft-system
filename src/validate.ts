import type { Config } from './config.js';
import type { Field, InvoiceFields, ReviewFlag } from './types.js';

export interface ValidateResult {
  flags: ReviewFlag[];
  shouldCreateDraft: boolean;
}

/** low 才意味着「拿不准」；medium（例如从 $ 符号推断币种、按账期推算到期日）仍可自动走，但会在面板上留痕 */
const isLow = (f: Field<unknown> | null): boolean => f?.confidence === 'low';

/**
 * 规则引擎：任何一条 flag 都意味着「不能默默过关」，要进人工复核。
 * 客户原话：模型说有 90% 把握本身不是质量保证。
 */
export function validate(
  fields: InvoiceFields,
  cfg: Config,
  ctx: { duplicateInvoiceNo: boolean },
): ValidateResult {
  const flags: ReviewFlag[] = [];
  const push = (code: ReviewFlag['code'], severity: ReviewFlag['severity'], message: string) =>
    flags.push({ code, severity, message });

  if (fields.extraction === 'none') push('OCR_NEEDED', 'block', 'PDF 没有可读文本层，疑似扫描件，需要 OCR 或人工录入');
  if (!fields.vendor.value) push('MISSING_REQUIRED_FIELD', 'block', '供应商名称缺失');
  if (!fields.invoiceNo.value) push('MISSING_REQUIRED_FIELD', 'block', '发票号缺失');
  if (!fields.total.value) push('MISSING_REQUIRED_FIELD', 'block', '总金额缺失');
  if (isLow(fields.currency)) push('CURRENCY_UNSUPPORTED', 'block', '币种未能确认，默认为配置币种，需要人工确认');
  if (isLow(fields.issueDate)) push('DATE_UNCERTAIN', 'block', '开票日期缺失或不确定');
  if (!fields.dueDate.value || isLow(fields.dueDate)) {
    push('DUE_DATE_MISSING', 'block', '到期日缺失，按账期推算，需要人工确认');
  }

  // 金额自洽：明细之和 + 税 必须等于总额，差一分钱也不沉默通过
  const lineSum = fields.lineItems.reduce((s, i) => s + i.lineAmount, 0);
  const base = fields.subtotal.value ?? (lineSum > 0 ? lineSum : fields.total.value ?? 0);
  if (fields.total.value !== null) {
    const expected = base + (fields.tax.value ?? 0);
    if (Math.abs(expected - fields.total.value) > cfg.validation.amountTolerance) {
      push('AMOUNT_MISMATCH', 'block', `金额不自洽：明细/小计 ${fmt(base)} + 税 ${fmt(fields.tax.value ?? 0)} ≠ 总额 ${fmt(fields.total.value)}`);
    }
  }
  if (fields.subtotal.value !== null && lineSum > 0 && Math.abs(lineSum - fields.subtotal.value) > cfg.validation.amountTolerance) {
    push('LINE_ITEM_SUM_MISMATCH', 'block', `明细项之和 ${fmt(lineSum)} 与小计 ${fmt(fields.subtotal.value)} 不一致`);
  }

  // 税率合理性：含税总额下 tax/net 应当接近法定 GST 税率（用 net 做分母，否则 10% 会算成 9.09%）
  if (fields.tax.value && fields.total.value) {
    const net = fields.total.value - fields.tax.value;
    const rate = net > 0 ? fields.tax.value / net : 0;
    const ok = cfg.validation.allowedTaxRates.some((r) => Math.abs(rate - r) < 0.005);
    if (!ok) push('TAX_RATE_UNEXPECTED', 'warn', `税率 ${(rate * 100).toFixed(1)}% 不在允许列表内`);
  }

  if (ctx.duplicateInvoiceNo) push('DUPLICATE_INVOICE_NO', 'block', '同一供应商此前已处理过相同发票号，需确认不是重复入账');

  const shouldCreateDraft = cfg.review.autoCreateWhen === 'no-flags' ? flags.length === 0 : false;
  return { flags, shouldCreateDraft };
}

const fmt = (n: number): string => n.toFixed(2);
