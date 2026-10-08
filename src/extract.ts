import { readFileSync } from 'node:fs';
import type { Config } from './config.js';
import { extractCnInvoice, looksLikeCnEInvoice } from './extract-cn.js';
import type { Confidence, Field, InvoiceFields, LineItem } from './types.js';

// 注意：千分位形式必须要求至少一组 ,xxx，否则 "3420.50" 会被截断成 "342"
const MONEY = '\\$?\\s*(-?\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,2})?|-?\\d+(?:\\.\\d{1,2})?)';
// 词首边界：否则 "Subtotal" 里的 total 会被当成「总额」匹配到
const BOUND = '(?:^|[^\\w])';
const DATE =
  '(\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\s+[A-Za-z]{3,9}\\s+\\d{2,4}|[A-Za-z]{3,9}\\s+\\d{1,2},?\\s+\\d{2,4})';

export interface ExtractResult {
  fields: InvoiceFields;
  pages: number;
}

export async function extractInvoice(pdfPath: string, cfg: Config): Promise<ExtractResult> {
  const buf = readFileSync(pdfPath);
  const { pages, text, provenance } = await readTextLayers(buf, cfg);
  const withOcr = text.trim().length >= cfg.filters.minTextConfidenceChars ? text : await maybeOcr(buf, cfg, provenance);
  void withOcr;
  const lines = text.split('\n').map((l) => l.trim());
  // 先判版式：中文数电发票走自己的模板，别拿英文发票那套关键词去硬套
  if (looksLikeCnEInvoice(lines)) {
    return { fields: extractCnInvoice(lines, cfg), pages };
  }
  const currency = detectCurrency(lines);
  const invoiceNo = findString(lines, [
    /(?:invoice|tax invoice|bill)(?:\s*(?:no|number|num|#))?\s*[:#]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,})/i,
  ]);
  const issueDate = findDate(lines, [/(?:invoice|issue|date of issue|dated?)\s*(?:of)?\s*[:.]?\s*/i]);
  const dueDate = findDate(lines, [/(?:due|payment due|due on|payable by|terms)\s*(?:date)?\s*[:.]?\s*/i]);
  const total = findNumber(lines, [/(?:total amount|amount due|balance due|grand total|total due|total)\s*[:.]?\s*/i]);
  const tax = findNumber(lines, [/(?:gst|vat|tax)\s*(?:\(?\s*\d+(?:\.\d+)?\s*%?\s*\)?)?\s*[:.]?\s*/i]);
  const subtotal = findNumber(lines, [/(?:sub total|subtotal|net amount|goods total)\s*[:.]?\s*/i]);
  const vendor = findVendor(lines);

  // 文本层太薄（扫描件/图片型 PDF/只泄露了一点字符）一律当「没有可读文本」处理，落到 OCR_NEEDED，
  // 而不是硬着头皮在残文本上正则——残文本上匹配出来的数字比没有更危险。
  const enoughText = text.trim().length >= cfg.filters.minTextConfidenceChars;
  const extraction: InvoiceFields['extraction'] = enoughText
    ? 'native'
    : cfg.extract.ocrEnabled
      ? 'ocr'
      : 'none';

  const fields: InvoiceFields = {
    vendor,
    invoiceNo,
    // findDate 找不到日期时返回 null（不是低置信空字段），落库前必须收敛成同一形状
    issueDate: issueDate ?? mk<string>(null, 'low', 'none'),
    dueDate: dueDate ?? deriveDueDate(issueDate, cfg),
    currency,
    subtotal,
    tax,
    total,
    taxType: cfg.xero.lineAmountTypes === 'Inclusive' ? 'Inclusive' : 'Exclusive',
    lineItems: findLineItems(lines),
    textChars: text.trim().length,
    extraction,
  };
  return { fields, pages };
}

async function readTextLayers(
  buf: Buffer,
  cfg: Config,
): Promise<{ pages: number; text: string; provenance: string }> {
  void cfg;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise;
    const parts: string[] = [];
    const prov: string[] = [];
    for (let p = 1; p <= doc.numPages; p += 1) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // pdfjs 不自带换行：按 transform 的 y 坐标把这些文本片段重新拼成行
      const lineItems: string[] = [];
      let lastY: number | null = null;
      for (const it of content.items) {
        if (!('str' in it) || !it.str) continue;
        const y = Number(it.transform?.[5] ?? 0);
        if (lastY === null || Math.abs(y - lastY) > 1) {
          lineItems.push(it.str.trim());
          lastY = y;
        } else {
          const last = lineItems[lineItems.length - 1];
          lineItems[lineItems.length - 1] = `${last} ${it.str.trim()}`.trim();
        }
      }
      const pageText = lineItems.join('\n').replace(/[ \t]+/g, ' ').trim();
      parts.push(pageText);
      prov.push(`native:p${p}`);
      page.cleanup();
    }
    await doc.destroy();
    return { pages: doc.numPages, text: parts.join('\n'), provenance: prov.join(',') };
  } catch {
    // PDF 损坏或加密：当作无文本层处理，交给校验层报 OCR_NEEDED
    return { pages: 0, text: '', provenance: 'unreadable' };
  }
}

async function maybeOcr(
  buf: Buffer,
  cfg: Config,
  provenance: string,
): Promise<string> {
  void buf;
  if (!cfg.extract.ocrEnabled) return '';
  if (cfg.extract.ocrProvider !== 'stub') throw new Error(`未知 OCR 提供方：${cfg.extract.ocrProvider}`);
  throw new Error('OCR 未接入：扫描件发票需要人工录入或配置 OCR 提供方');
}

function mk<T>(value: T | null, confidence: Confidence, source: string, raw?: string): Field<T> {
  return value === null ? { value: null, confidence: 'low', source, raw } : { value, confidence, source, raw };
}

function findString(lines: string[], patterns: RegExp[]): Field<string> {
  for (const line of lines) {
    for (const re of patterns) {
      const r = new RegExp(BOUND + re.source, 'i');
      const m = line.match(r);
      // 发票号必须带数字：否则会把 "Invoice Date: ..." 里的 Date 当成发票号
      if (m?.[1] && /\d/.test(m[1])) return mk(m[1].trim(), 'high', 'native:p1', m[1].trim());
    }
  }
  return mk<string>(null, 'low', 'none');
}

function findNumber(lines: string[], patterns: RegExp[]): Field<number> {
  for (const line of lines) {
    for (const re of patterns) {
      const re2 = new RegExp(BOUND + re.source + MONEY, 'i');
      const m = line.match(re2);
      if (m?.[1]) return mk(parseNum(m[1]), 'high', 'native:p1', m[1]);
    }
  }
  return mk<number>(null, 'low', 'none');
}

function findDate(lines: string[], patterns: RegExp[]): Field<string> | null {
  for (const line of lines) {
    for (const re of patterns) {
      const m = line.match(new RegExp(BOUND + re.source + DATE, 'i'));
      if (m?.[1]) {
        const iso = toIso(m[1]);
        return iso ? mk(iso, 'high', 'native:p1', m[1]) : null;
      }
    }
  }
  return null;
}

/** 没有到期日时按账期推算，但降级为 medium 置信度，靠人工复核兜底。
 *  关键：调用方拿到的日期字段可能是 null（整封 PDF 一行日期都没匹配到），这里必须能接住，
 *  不能解引用崩在 pipeline 里——崩了任务会进 retry 而不是进人工复核。 */
function deriveDueDate(issueDate: Field<string> | null, cfg: Config): Field<string> {
  void cfg;
  if (!issueDate?.value) return mk<string>(null, 'low', 'none');
  const d = new Date(issueDate.value);
  if (Number.isNaN(d.getTime())) return mk<string>(null, 'low', 'none');
  d.setDate(d.getDate() + 30);
  return mk(d.toISOString().slice(0, 10), 'medium', 'derived:issueDate+30d');
}

function toIso(raw: string): string | null {
  const s = raw.trim();
  const dm = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dm) {
    const year = dm[3]!.length === 2 ? `20${dm[3]}` : dm[3]!;
    return `${year}-${dm[2]!.padStart(2, '0')}-${dm[1]!.padStart(2, '0')}`;
  }
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2]!.padStart(2, '0')}-${iso[3]!.padStart(2, '0')}`;
  const md = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{2,4})$/);
  if (md) return `${md[3]!.length === 2 ? `20${md[3]}` : md[3]}-${month(md[2]!)}-${md[1]!.padStart(2, '0')}`;
  const mdy = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (mdy) return `${mdy[3]}-${month(mdy[1]!)}-${mdy[2]!.padStart(2, '0')}`;
  return null;
}

function month(name: string): string {
  const map: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  return map[name.slice(0, 3).toLowerCase()] ?? '01';
}

function parseNum(s: string): number {
  return Number(s.replace(/[^\d.-]/g, ''));
}

function detectCurrency(lines: string[]): Field<string> {
  const joined = lines.join(' ');
  for (const code of ['NZD', 'AUD', 'USD', 'GBP', 'CNY']) {
    if (new RegExp(`\\b${code}\\b`).test(joined)) return mk(code, 'high', 'native:p1');
  }
  if (joined.includes('$')) return mk('NZD', 'medium', 'assumed:$symbol');
  return mk('NZD', 'low', 'assumed:config', '');
}

/**
 * 发票模板行（标题、表头、字段名）也算「短、无数字」，但它们是模板不是供应商：
 * 中文数电发票会把「电子发票（普通发票） 发票号码：」整行顶到文本最前面，
 * 英文发票同理常以 "TAX INVOICE" 开头。不排掉的话，抓出来的是 high 置信度的鬼话
 * （真实案例：vendor = "电子发票（普通发票） 发票号码："）。
 */
const VENDOR_TEMPLATE_LINE =
  /^(?:电子发票|增值税|普通发票|专用发票|发票号码|发票代码|开票日期|开票人|收款人|复核人|购买方|销售方|名称|纳税人识别号|统一社会信用代码|价税合计|合计|项目|规格|单位|数量|单价|金额|备注)/i;

function findVendor(lines: string[]): Field<string> {
  for (const line of lines.slice(0, 6)) {
    if (
      line.length < 60 &&
      line.length > 2 &&
      !/\d/.test(line) &&
      !VENDOR_TEMPLATE_LINE.test(line)
    ) {
      return mk(line.trim(), 'high', 'native:p1');
    }
  }
  const first = lines.find((l) => l.length > 2);
  return first ? mk(first.trim().slice(0, 60), 'low', 'fallback:p1') : mk<string>(null, 'low', 'none');
}

function findLineItems(lines: string[]): LineItem[] {
  const start = lines.findIndex((l) => /qty|description|item/i.test(l));
  if (start < 0) return [];
  const items: LineItem[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/total|subtotal|gst|tax|amount due/i.test(line)) break;
    const nums = line.match(new RegExp(MONEY, 'g'));
    if (!nums || nums.length < 2) continue;
    const amount = parseNum(nums[nums.length - 1]!);
    const unit = parseNum(nums[nums.length - 2]!);
    if (!Number.isFinite(amount) || !Number.isFinite(unit)) continue;
    // 数量是行里第一个数字；认不出来就记 1 并留痕，别把 20 当成金额
    const qtyRaw = nums[0] ? parseNum(nums[0]!) : 1;
    const quantity = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : 1;
    const desc = line
      .replace(new RegExp(MONEY, 'g'), ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    if (desc.length < 3) continue;
    items.push({ description: desc, quantity, unitAmount: unit, lineAmount: amount });
  }
  return items;
}
