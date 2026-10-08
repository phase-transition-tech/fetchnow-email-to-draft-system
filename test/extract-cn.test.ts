import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, resolvePaths } from '../src/config.js';
import { extractInvoice } from '../src/extract.js';
import { validate } from '../src/validate.js';
import type { Config } from '../src/config.js';

const root = path.resolve(import.meta.dirname, '..');
const sample = path.join(root, 'fixtures/samples/cn-einvoice-sample.pdf');

let cfg: Config;
try {
  cfg = resolvePaths(loadConfig());
} catch (err) {
  rmSync(mkdtempSync(path.join(os.tmpdir(), 'unused-')), { recursive: true, force: true });
  throw err;
}

after(() => {
  // 样本 PDF 在仓库里，不动
});

async function extract(): Promise<ReturnType<typeof extractInvoice>> {
  return extractInvoice(sample, cfg);
}

test('中文数电发票：20 位号码、开票日期、币种一次性认全', async () => {
  const { fields } = await extract();
  assert.equal(fields.invoiceNo.value, '26372000004880622631');
  assert.equal(fields.issueDate.value, '2026-10-02');
  assert.equal(fields.currency.value, 'CNY');
  assert.equal(fields.currency.confidence, 'high');
});

test('中文数电发票：供应商取的是销售方，不是购买方', async () => {
  const { fields } = await extract();
  assert.equal(fields.vendor.value, '开心小胖餐饮管理（济南）有限公司');
  assert.equal(fields.vendor.confidence, 'high');
  // 购买方必须没混进来
  assert.ok(!String(fields.vendor.value).includes('中闻'));
});

test('中文数电发票：金额拆成 小计 + 税 = 价税合计，且自洽', async () => {
  const { fields } = await extract();
  assert.equal(fields.subtotal.value, 712.87);
  assert.equal(fields.tax.value, 7.13);
  assert.equal(fields.total.value, 720.0);
  // 校验器自己也会算一遍：这里先确认我们喂进去的数是能过的
  const res = validate(fields, cfg, { duplicateInvoiceNo: false });
  assert.equal(
    res.flags.find((f) => f.code === 'AMOUNT_MISMATCH'),
    undefined,
    '712.87 + 7.13 必须等于 720.00',
  );
});

test('中文数电发票：明细只从「带小数点」的数里取，不吃拼接整数', async () => {
  const { fields } = await extract();
  assert.equal(fields.lineItems.length, 1);
  const item = fields.lineItems[0]!;
  assert.equal(item.description, '*生产生活服务*餐饮服务');
  assert.equal(item.lineAmount, 712.87);
  assert.equal(item.quantity, 1);
});

test('中文数电发票：干净可直接建草稿（零 flag）', async () => {
  const { fields } = await extract();
  const res = validate(fields, cfg, { duplicateInvoiceNo: false });
  assert.deepEqual(
    res.flags.map((f) => f.code),
    [],
    `不该有 flag，实际：${res.flags.map((f) => `${f.code}:${f.message}`).join(' | ')}`,
  );
  assert.equal(res.shouldCreateDraft, true);
});

test('中文发票不会误伤英文发票：判版式时各走各的', async () => {
  const { extractCnInvoice, looksLikeCnEInvoice } = await import('../src/extract-cn.js');
  const englishLines = ['Southwind Trading Ltd', 'TAX INVOICE', 'Invoice No: INV-2026-0912', 'Total Amount Due 3762.55'];
  assert.equal(looksLikeCnEInvoice(englishLines), false, '英文发票不该被判成中文发票');
  const cn = extractCnInvoice(['电子发票（普通发票） 发票号码：', '¥712.87 ¥7.13'], cfg);
  assert.equal(cn.total.value, 7.13, '只有一行 ¥ 时退化处理，不该崩，也不该假装有小计');
});
