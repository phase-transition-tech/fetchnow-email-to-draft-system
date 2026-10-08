import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, resolvePaths } from '../src/config.js';
import { createInvoice, open, updateInvoice } from '../src/db.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'fetchnow-db-'));
const cwd = process.cwd();
process.chdir(tmp);

let handle: ReturnType<typeof open>;
try {
  handle = open(resolvePaths(loadConfig({ storage: { dir: path.join(tmp, 'data') } })));
} catch (err) {
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
  throw err;
}

after(() => {
  handle.db.close();
  process.chdir(cwd);
  rmSync(tmp, { recursive: true, force: true });
});

/** 存进 sqlite 之后，missing 字段必须是真 NULL，不能是字面量字符串 "null" */
test('updateInvoice 写 null 时落的是 SQL NULL，不是字符串 "null"', () => {
  createInvoice(handle.db, {
    sha256: 'null-marshalling',
    messageId: 'msg@null.test',
    filename: 'x.pdf',
    rawPath: path.join(tmp, 'x.pdf'),
  });

  // 数值/字符串照常落盘
  updateInvoice(handle.db, 1, { total: 12.34, vendor: 'ACME' });
  // 显式 null 必须清成 NULL，而不是 "null"
  updateInvoice(handle.db, 1, { invoice_no: null, total: null, last_error: null });

  const row = handle.db.prepare('SELECT * FROM invoices WHERE id = 1').get() as Record<string, unknown>;

  assert.equal(row.vendor, 'ACME', '字符串照常落盘');
  assert.equal(row.total, null, 'total 被 null 清成真 NULL（不是 "null"）');
  assert.equal(row.invoice_no, null, 'invoice_no 必须是 SQL NULL');
  assert.equal(row.last_error, null, 'last_error 必须是 SQL NULL');

  // 关键回归点：'null' 是 truthy，真 NULL 是 falsy
  assert.ok(!row.total, 'total 必须 falsy，否则「字段缺失」的判断会失效');
  assert.ok(!row.invoice_no, 'invoice_no 必须 falsy');
  assert.equal(typeof row.total, 'object', 'NULL 在 sqlite 驱动里读出来是 null');
});
