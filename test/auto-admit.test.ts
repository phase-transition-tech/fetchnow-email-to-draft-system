import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, resolvePaths } from '../src/config.js';
import { listInvoices, open, type DbHandle } from '../src/db.js';
import { senderAddr } from '../src/ingest.js';
import { autoAdmitTrusted, processOnce } from '../src/pipeline.js';
import { resetMockCallLog } from '../src/xero.js';
import { writeFixtures } from '../scripts/make-fixtures.mjs';

interface Fixture {
  tmp: string;
  handle: DbHandle;
  stop: () => void;
}

function setup(autoAdmitDomains: string[], allowedDomains: string[] = []): Fixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fetchnow-auto-'));
  const inbox = path.join(tmp, 'inbox');
  writeFixtures(inbox);
  const config = resolvePaths(
    loadConfig({
      ingest: { mode: 'folder', folder: { path: inbox }, folderBackfillDays: 7 },
      storage: { dir: path.join(tmp, 'data') },
      review: { autoAdmitDomains },
      filters: { allowedSenderDomains: allowedDomains },
    }),
  );
  const handle = open(config);
  resetMockCallLog();
  return { tmp, handle, stop: () => { handle.db.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

test('发件人地址能从「显示名 <a@b.com>」里剥出来', () => {
  assert.equal(senderAddr('Southwind <billing@southwind-trading.example>'), 'billing@southwind-trading.example');
  assert.equal(senderAddr('billing@southwind-trading.example'), 'billing@southwind-trading.example');
  assert.equal(senderAddr(''), '');
});

test('白名单命中的发件人自动纳入，其余仍等人确认', async () => {
  const f = setup(['southwind-trading.example']);
  tmpDirs.push(f.tmp);
  // ingestOnce 里不 admitting，这里手动跑一次收件，再看自动纳入的结果
  const { ingestOnce } = await import('../src/pipeline.js');
  await ingestOnce(f.handle);

  const total = listInvoices(f.handle.db).length;
  assert.equal(total, 4, '四封邮件都应进观察池（白名单此时还没生效）');

  const res = autoAdmitTrusted(f.handle);
  assert.equal(res.admitted, 1, '只有 southwind 那封命中白名单');
  assert.equal(res.pending, 3, '剩下三封停在「待开票输入」等人确认');

  const admittedRows = listInvoices(f.handle.db, 'admitted');
  assert.equal(admittedRows.length, 1);
  // 字段此刻还没提取（提取发生在 process 阶段），判定要落在 from_addr 上
  assert.equal(admittedRows[0]?.from_addr, 'billing@southwind-trading.example');

  // 自动纳入的那条不该卡在人工门上：直接就能被处理掉
  const s = await processOnce(f.handle);
  assert.equal(s.created, 1, '自动纳入的那张票应直接建出草稿');
  assert.equal(s.review, 0);
  f.stop();
});

test('白名单为空时永远不自动纳入（安全默认）', async () => {
  const f = setup([]);
  tmpDirs.push(f.tmp);
  const { ingestOnce } = await import('../src/pipeline.js');
  await ingestOnce(f.handle);

  const res = autoAdmitTrusted(f.handle);
  assert.equal(res.admitted, 0);
  assert.equal(listInvoices(f.handle.db, 'observed').length, 4, '全部停在观察池');
  const s = await processOnce(f.handle);
  assert.equal(s.processed, 0, '没有 admitted 的任务就不该处理任何东西');
  f.stop();
});

test('发件人白名单不匹配的邮件直接挡在观察池外', async () => {
  const f = setup([], ['southwind-trading.example']);
  tmpDirs.push(f.tmp);
  const { ingestOnce } = await import('../src/pipeline.js');
  const r = await ingestOnce(f.handle);

  assert.equal(r.scanned, 4);
  // 白名单只放南风一家，另外三家（billing 之外全被挡：扫描件、金额不自洽、垃圾营销）
  assert.equal(r.filtered, 3, '不在白名单里的三封都应被挡在观察池外');
  assert.equal(r.inserted, 1);
  const rows = listInvoices(f.handle.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.from_addr, 'billing@southwind-trading.example');
  const reasons = (f.handle.db.prepare('SELECT reason FROM filtered').all() as { reason: string }[]).map(
    (x) => x.reason,
  );
  assert.ok(
    reasons.some((x) => x.includes('ecomarketing.example')),
    '垃圾营销邮件应出现在被过滤记录里',
  );
  f.stop();
});
