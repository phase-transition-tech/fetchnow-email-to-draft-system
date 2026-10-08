import { mkdirSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';

const escapeParen = (s) => s.replace(/([\\()])/g, '\\$1');

function assemblePdf(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${obj}\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** 纯位图 PDF：一个文本层都没有，用来模拟扫描仪出来的发票 */
export function buildPdfImage(width = 8, height = 8, rgb = [0xd0, 0xd0, 0xd0]) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = rgb[0];
    pixels[i * 3 + 1] = rgb[1];
    pixels[i * 3 + 2] = rgb[2];
  }
  const content = 'q\n1 0 0 1 0 0 cm\n/Im0 Do\nQ\n';
  return assemblePdf([
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>\nendobj',
    `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream\nendobj`,
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels.toString('latin1')}\nendstream\nendobj`,
  ]);
}

/** 手写一个最小合法 PDF（Helvetica 单行文本），避免为了造数据再引入依赖 */
export function buildPdfText(lines) {
  const content = lines
    .map((l, i) => `BT /F1 10 Tf 1 0 0 1 40 ${800 - i * 14} Tm (${escapeParen(l)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function buildEml({ from, to, subject, messageId, date, body, attachments = [] }) {
  const bound = `----=_FN_boundary_${Math.random().toString(36).slice(2, 10)}`;
  let out = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${bound}"`,
    '',
  ].join('\r\n');
  out += `--${bound}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n${body}\r\n`;
  for (const a of attachments) {
    out +=
      `--${bound}\r\nContent-Type: ${a.contentType}; name="${a.filename}"\r\n` +
      `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename}"\r\n\r\n` +
      `${a.buffer.toString('base64')}\r\n`;
  }
  return `${out}--${bound}--\r\n`;
}

const GOOD_INVOICE = [
  'Southwind Trading Ltd',
  'TAX INVOICE',
  'Invoice No: INV-2026-0912',
  'Invoice Date: 27/09/2026',
  'Due Date: 27/10/2026',
  'All amounts in NZD',
  'Description          Qty    Unit        Amount',
  'Consulting retainer    20    150.00     3000.00',
  'Travel reimbursement   1     420.50      420.50',
  'Subtotal                                3420.50',
  'GST 10%                                  342.05',
  'Total Amount Due                       3762.55',
];

const BROKEN_INVOICE = [
  'Northline Supplies GmbH',
  'RECHNUNG',
  'Invoice No: EU-778812',
  'Invoice Date: 2026-09-02',
  'Due Date: 2026-10-02',
  'Description             Qty    Unit      Amount',
  'Pallet crate            4      85.00     340.00',
  'Freight                 1      260.00    260.00',
  'Subtotal                              600.00',
  'VAT 19%                               114.00',
  'Total Amount Due                     9999.00',
];

const SCANNED_INVOICE = [
  'Riverbend Print Studio',
  'SCANNED COPY - NO TEXT LAYER',
];

const JUNK_MAIL = [
  'Webinar: how to cut your costs',
  'Download our free ebook today',
];

export function writeFixtures(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const to = 'invoices@fetchnow.local';
  const pdf = (name, lines) => ({ filename: name, contentType: 'application/pdf', buffer: buildPdfText(lines) });

  const files = {
    'a-southwind-native.eml': buildEml({
      from: 'billing@southwind-trading.example',
      to,
      subject: 'Tax invoice INV-2026-0912',
      messageId: 'a-southwind-001@example',
      date: 'Fri, 25 Sep 2026 09:12:04 +1200',
      body: 'Please find attached our tax invoice.',
      attachments: [pdf('INV-2026-0912.pdf', GOOD_INVOICE)],
    }),
    'b-riverbend-scanned.eml': buildEml({
      from: 'accounts@riverbendprint.example',
      to,
      subject: 'Invoice scan',
      messageId: 'b-riverbend-001@example',
      date: 'Fri, 25 Sep 2026 10:03:00 +1200',
      body: 'Attached is the scan of your invoice.',
      // 扫描件：真实扫描仪产物通常只有位图，文本层为空
      attachments: [{ filename: 'scan_001.pdf', contentType: 'application/pdf', buffer: buildPdfImage() }],
    }),
    'c-northline-mismatch.eml': buildEml({
      from: 'rechnung@northline-supplies.example',
      to,
      subject: 'Rechnung EU-778812',
      messageId: 'c-northline-001@example',
      date: 'Sat, 26 Sep 2026 08:41:00 +1200',
      body: 'Our invoice.',
      attachments: [pdf('EU-778812.pdf', BROKEN_INVOICE)],
    }),
    'd-junk-marketing.eml': buildEml({
      from: 'hello@ecomarketing.example',
      to,
      subject: 'Webinar invitation',
      messageId: 'd-junk-001@example',
      date: 'Sat, 26 Sep 2026 07:00:00 +1200',
      body: 'Join our webinar.',
      attachments: [pdf('ebook.pdf', JUNK_MAIL)],
    }),
  };

  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return Object.keys(files);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('make-fixtures.mjs');
if (invokedDirectly) {
  const dir = process.argv[2] ?? path.resolve(process.cwd(), 'fixtures/inbox');
  const names = writeFixtures(dir);
  console.log(`已生成 ${names.length} 个测试邮件到 ${dir}`);
}
