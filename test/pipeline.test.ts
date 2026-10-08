import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, resolvePaths } from '../src/config.js';
import { listInvoices, open, type DbHandle } from '../src/db.js';
import { admitInvoice, ingestOnce, processOnce } from '../src/pipeline.js';
import { getMockCallLog, resetMockCallLog } from '../src/xero.js';
import { writeFixtures } from '../scripts/make-fixtures.mjs';

interface Fixture {
  tmp: string;
  handle: DbHandle;
  stop: () => void;
}

function setup(): Fixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fetchnow-'));
  const inbox = path.join(tmp, 'inbox');
  writeFixtures(inbox);
  const config = resolvePaths(
    loadConfig({
      ingest: { mode: 'folder', folder: { path: inbox }, folderBackfillDays: 7 },
      storage: { dir: path.join(tmp, 'data') },
    }),
  );
  const handle = open(config);
  resetMockCallLog();
  return { tmp, handle, stop: () => { handle.db.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

async function admitAll(handle: DbHandle): Promise<void> {
  for (const row of listInvoices(handle.db, 'observed')) admitInvoice(handle, Number(row.id));
}

/** worker 串行一次只取一条，测试里要一直抽到队列空；带退避的任务要累计看总量，只看最后一次会漏 */
async function drain(handle: DbHandle) {
  const total = { processed: 0, created: 0, review: 0, retried: 0, dead: 0, skipped: 0 };
  for (let i = 0; i < 20; i += 1) {
    const s = await processOnce(handle);
    for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
    if (s.processed === 0) break;
  }
  return total;
}

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

test('同一封邮件反复扫描，只建一条草稿', async () => {
  const f = setup();
  tmpDirs.push(f.tmp);
  const first = await ingestOnce(f.handle);
  const second = await admitAll(f.handle).then(() => ingestOnce(f.handle));

  assert.equal(first.inserted, 4, '四封测试邮件应各产生一条发票任务');
  assert.equal(second.inserted, 0, '重复扫描不应再入库');
  assert.equal(second.duplicates, 4, '重复的那几封应被识别为重复');

  const summary = await processOnce(f.handle);
  assert.equal(summary.created, 1, '只有金额自洽的那张发票能自动建草稿');
  assert.equal(getMockCallLog().length, 1);
  f.stop();
});

test('金额自洽不过关的发票转人工，且不会建单', async () => {
  const f = setup();
  tmpDirs.push(f.tmp);
  await ingestOnce(f.handle);
  await admitAll(f.handle);
  const before = getMockCallLog().length;
  const summary = await drain(f.handle);

  const broken = listInvoices(f.handle.db).find((r) => r.invoice_no === 'EU-778812');
  assert.ok(broken, '应存在金额不自洽的任务');
  assert.equal(broken?.status, 'review');
  const flags = JSON.parse(String(broken?.flags ?? '[]')) as string[];
  assert.ok(flags.includes('AMOUNT_MISMATCH'), `应报金额不自洽，实际 flags=${flags.join(',')}`);
  assert.equal(summary.review, 3, '扫描件、金额不自洽、垃圾邮件三条都应转人工');
  assert.equal(
    getMockCallLog().length,
    1,
    '整轮只应有那张自洽发票建单，转人工的三条不得碰建单接口',
  );
  f.stop();
});

test('没有文本层的扫描件要求 OCR，不静默填数字', async () => {
  const f = setup();
  tmpDirs.push(f.tmp);
  await ingestOnce(f.handle);
  await admitAll(f.handle);
  await drain(f.handle);

  const rows = listInvoices(f.handle.db);
  const scanned = rows.find((r) => r.filename === 'scan_001.pdf');
  assert.ok(scanned, `应存在扫描件任务，实际：${JSON.stringify(rows.map((r) => ({ id: r.id, no: r.invoice_no, st: r.status, flags: r.flags })))}`);
  assert.equal(scanned?.status, 'review');
  const flags = JSON.parse(String(scanned?.flags ?? '[]')) as string[];
  assert.ok(flags.includes('OCR_NEEDED'), `扫描件应报 OCR_NEEDED，实际 ${flags.join(',')}`);
  f.stop();
});

test('终态永远是草稿，不存在任何自动批准动作', async () => {
  const f = setup();
  tmpDirs.push(f.tmp);
  await ingestOnce(f.handle);
  await admitAll(f.handle);
  await drain(f.handle);

  const draftsDir = f.handle.config.storage.draftsDir;
  const files = readdirSync(draftsDir).filter((x) => x.endsWith('.json'));
  assert.equal(files.length, 1, '只应落一份草稿');
  const draft = JSON.parse(readFileSync(path.join(draftsDir, files[0]!), 'utf8'));
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.Type, 'ACCPAY');
  assert.equal(draft.total, 3762.55);
  f.stop();
});

test('重推已有发票不会重复建单', async () => {
  const f = setup();
  tmpDirs.push(f.tmp);
  await ingestOnce(f.handle);
  await admitAll(f.handle);
  await processOnce(f.handle);
  assert.equal(getMockCallLog().length, 1);

  // 模拟人从面板点了「重新处理」：任务重新入队，但幂等键不变
  const created = listInvoices(f.handle.db, 'created')[0];
  f.handle.db
    .prepare("UPDATE invoices SET status = 'admitted', attempt_count = 0 WHERE id = ?")
    .run(Number(created!.id));
  const summary = await processOnce(f.handle);

  assert.equal(summary.skipped, 1, '已建过草稿的任务应被结果层拦下');
  assert.equal(getMockCallLog().length, 1, '重推后仍只能有一份草稿');
  f.stop();
});
