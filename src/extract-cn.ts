import type { Config } from './config.js';
import type { Field, InvoiceFields, LineItem } from './types.js';

/**
 * 中文数电发票（全电发票）模板提取器。
 *
 * 为什么不能用上面那套英文正则：`Total Amount Due` / `NZD` / `Subtotal` 这些锚点，
 * 在数电发票上一处都不存在。它的文本层是好的（pdfjs 能抽出几百字符），但结构是
 * 「购买方信息 / 销售方信息 / 货物或应税劳务 / 价税合计」这套中文税票排版，
 * 硬拿英文正则去缝只会缝出不自洽的数字——那比认不出来更危险。
 *
 * 真实样本（2026-10-05 用户实测的一张票，pdfjs 按 y 坐标合并后的行）：
 *   电子发票（普通发票） 发票号码：
 *   开票日期：
 *   购 / 买 / 方 / 信 / 息 统一社会信用代码/纳税人识别号：
 *   销 / 售 / 方 / 信 / 息 统一社会信用代码/纳税人识别号：
 *   名称： 名称：
 *   *生产生活服务*餐饮服务 1%桌 712.87 7.13712.8712871287131
 *   26372000004880622631        <- 发票号码（20 位）
 *   2026年10月02日              <- 开票日期
 *   北京市中闻（深圳）律师事务所 <- 购买方名称
 *   31440000MD0219667A          <- 购买方税号
 *   开心小胖餐饮管理（济南）有限公司 <- 销售方名称
 *   91370104MA3RAQTFXH          <- 销售方税号
 *   ¥712.87 ¥7.13               <- 合计（金额 / 税额）
 *   柒佰贰拾圆整 ¥720.00         <- 价税合计（小写）
 *
 * 所以这里每条规则都挑「不依赖行列位置、只依赖内容特征」的锚点。
 */

/** 数电发票号码固定 20 位数字；老版纸质发票是 8/10 位代码 + 8 位号码，也一并收 */
const CN_INVOICE_NO = /(\d{20}|\d{8}(?:\s*\d{8})?)/;
/** 统一社会信用代码 / 纳税人识别号：18 位大写字母+数字，且必须同时含字母和数字 */
const CN_TAX_ID = /\b(?=.*\d)(?=.*[A-Z])[0-9A-Z]{18}\b/;
const CN_DATE = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
const YUAN = /[¥￥]/;
/** 带分位的金额；只认「有小数点的数」，避开 2871287131 这种把相邻栏位连成一串的整数 */
const CN_AMOUNT = /[¥￥]\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g;
const CN_MONEY = /(\d+(?:\.\d{1,2})?)/g;

export function looksLikeCnEInvoice(lines: string[]): boolean {
  const joined = lines.join('\n');
  // 中文字段名 + 人民币符号，两个条件同时成立才算中文发票——只凭「电子发票」会把
  // 同时含中文说明文字的其他英文账单误判进来
  return /电子发票|增值税|发票号码/.test(joined) && YUAN.test(joined);
}

export function extractCnInvoice(lines: string[], cfg: Config): InvoiceFields {
  const text = lines.join('\n');

  const invoiceNo = cnField<string>(text.match(CN_INVOICE_NO)?.[1] ?? null, 'native:invoiceNo');
  const issueDate = cnDate(text.match(CN_DATE));
  const currency: Field<string> = YUAN.test(text)
    ? { value: 'CNY', confidence: 'high', source: 'native:¥symbol' }
    : { value: null, confidence: 'low', source: 'none' };

  // 金额：全部 ¥ 金额按文本顺序排列，最后一个必定是价税合计（最下面那行）
  const yuan = [...text.matchAll(CN_AMOUNT)].map((m) => parseCnNum(m[1]));
  const total: Field<number> = yuan.length
    ? { value: yuan[yuan.length - 1]!, confidence: 'high', source: 'native:total', raw: String(yuan[yuan.length - 1]) }
    : { value: null, confidence: 'low', source: 'none' };

  // 「合计」行同时写金额和税额（¥712.87 ¥7.13）；只有一个 ¥ 时退化成没拆
  const totalLine = lines.find((l) => (l.match(/[¥￥]/g) ?? []).length >= 2);
  const pair = [...(totalLine ?? '').matchAll(CN_AMOUNT)].map((m) => parseCnNum(m[1]!));
  const subtotal: Field<number> = pair.length >= 2
    ? { value: pair[0]!, confidence: 'high', source: 'native:sum', raw: String(pair[0]) }
    : { value: null, confidence: 'low', source: 'none' };
  const tax: Field<number> = pair.length >= 2
    ? { value: pair[1]!, confidence: 'medium', source: 'native:tax', raw: String(pair[1]) }
    : { value: null, confidence: 'low', source: 'none' };

  const fields: InvoiceFields = {
    vendor: findCnVendor(lines),
    invoiceNo,
    issueDate,
    dueDate: deriveCnDueDate(issueDate),
    currency,
    subtotal,
    tax,
    total,
    taxType: cfg.xero.lineAmountTypes === 'Inclusive' ? 'Inclusive' : 'Exclusive',
    lineItems: findCnLineItems(lines),
    textChars: text.trim().length,
    extraction: 'native',
  };
  return fields;
}

function cnField<T>(value: T | null, source: string): Field<T> {
  return value === null
    ? { value: null, confidence: 'low', source }
    : { value, confidence: 'high', source };
}

function cnDate(m: RegExpMatchArray | null): Field<string> {
  if (!m) return { value: null, confidence: 'low', source: 'none' };
  const month = m[2]!.padStart(2, '0');
  const day = m[3]!.padStart(2, '0');
  const iso = `${m[1]}-${month}-${day}`;
  return Number.isNaN(new Date(iso).getTime())
    ? { value: null, confidence: 'low', source: 'none' }
    : { value: iso, confidence: 'high', source: 'native:issueDate', raw: `${m[1]}年${month}月${day}日` };
}

/** 数电发票没有付款到期日，按账期给一个 medium 推算值——medium 不触发 DUE_DATE_MISSING，
 *  但会在面板上留痕，比直接报「缺少到期日」更贴近真实习惯 */
function deriveCnDueDate(issueDate: Field<string>): Field<string> {
  if (!issueDate.value) return { value: null, confidence: 'low', source: 'none' };
  const d = new Date(issueDate.value);
  if (Number.isNaN(d.getTime())) return { value: null, confidence: 'low', source: 'none' };
  d.setDate(d.getDate() + 30);
  return {
    value: d.toISOString().slice(0, 10),
    confidence: 'medium',
    source: 'derived:issueDate+30d',
  };
}

/**
 * 销售方名称 = 最后一个税号的上一行。
 * 数电发票是左右双栏：购买方信息块在上、销售方信息块在下，pdfjs 按坐标输出时
 * 卖方块排在后。靠这个位置关系拿销售方，比去猜「名称： 名称：」后面第几行稳得多
 * （那一行之后还夹着发票号和日期，直接数行必错）。
 */
function findCnVendor(lines: string[]): Field<string> {
  const taxIdLines: number[] = [];
  lines.forEach((l, i) => {
    if (CN_TAX_ID.test(l)) taxIdLines.push(i);
  });
  const last = taxIdLines[taxIdLines.length - 1];
  if (last === undefined) return { value: null, confidence: 'low', source: 'none' };
  for (let i = last - 1; i >= 0; i -= 1) {
    const name = lines[i]!.trim();
    if (name.length < 4) continue;
    if (!/[\u4e00-\u9fa5]/.test(name)) continue;
    if (/名称|发票|税|合计|备注|开票|购|销/.test(name)) continue;
    return { value: name.slice(0, 80), confidence: 'high', source: 'native:sellerBlock', raw: name };
  }
  return { value: null, confidence: 'low', source: 'none' };
}

/**
 * 明细行长这样：`*生产生活服务*餐饮服务 1%桌 712.87 7.13712.8712871287131`
 * 各栏（项目名/规格/单位/数量/单价/金额/税率/税额）全挤成一行且没有分隔符，
 * 所以只取「带小数点的数」当金额候选——1287131 这种拼接整数自动出局。
 */
function findCnLineItems(lines: string[]): LineItem[] {
  const items: LineItem[] = [];
  for (const line of lines) {
    const head = line.match(/^(\*[^*]+\*[^\d]*)/);
    if (!head) continue;
    const description = head[1]!.trim();
    const nums = [...line.matchAll(CN_MONEY)].map((m) => Number(m[1]));
    const amounts = nums.filter((n) => /[.]/.test(String(n)) && n > 0.005);
    if (amounts.length === 0) continue;
    const lineAmount = amounts[amounts.length - 1]!;
    const unitAmount = amounts[0]!;
    // 数量在金额前面且一定是整数：1287131 这类拼接整数会被 <10000 挡掉
    const qtyRaw = nums.find((n) => Number.isInteger(n) && n > 0 && n < 10000);
    const quantity = qtyRaw ?? 1;
    items.push({ description, quantity, unitAmount, lineAmount });
  }
  return items;
}

function parseCnNum(s: string | undefined): number {
  return Number((s ?? '').replace(/,/g, ''));
}
