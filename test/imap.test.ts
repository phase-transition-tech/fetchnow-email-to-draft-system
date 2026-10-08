import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { imapDate, loadState, maxUid, saveState, scanWindow, searchCriteria, type ImapState } from '../src/imap.js';

/**
 * IMAP 层的可测部分是这些「算错就漏票 / 重复拉」的纯逻辑。
 * 真协议交互（连接、idle、uid 搜索）只能靠 `node --import tsx src/cli.ts imap check` 对真实邮箱验证，
 * 所以这里把最容易出错的时间格式与水位推进钉死。
 */
describe('IMAP 收件层纯逻辑', () => {
  const cfg = loadConfig({ ingest: { imap: { statePath: path.join(mkdtempSync(path.join(tmpdir(), 'imap-')), 'state.json') } } });

  it('SINCE 日期必须是 UTC 的 DD-Mon-YYYY（Gmail 对此严格，本地时区会差一天）', () => {
    assert.equal(imapDate(new Date('2026-01-01T00:00:00Z')), '01-Jan-2026');
    assert.equal(imapDate(new Date('2026-12-31T23:59:59Z')), '31-Dec-2026');
    assert.equal(imapDate(new Date('2026-03-05T07:00:00Z')), '05-Mar-2026');
    // 单日必须补零，Gmail 吃 `1-Jan-2026` 会直接报 BAD
    assert.equal(imapDate(new Date('2026-09-07T12:00:00Z')), '07-Sep-2026');
    // 跨年边界：UTC 12-31 不能因为本地时区跳到明年
    assert.equal(imapDate(new Date('2025-12-31T16:00:00Z')), '31-Dec-2025');
  });

  it('UID 水位只往前推，不回退', () => {
    assert.equal(maxUid([]), null);
    assert.equal(maxUid([12, 3, 45]), 45);
    assert.equal(maxUid([0, 7]), 7);
  });

  it('冷启动全量回溯，刚扫过才走增量窗口', () => {
    const now = new Date('2026-10-03T02:00:00Z');
    const cold = scanWindow(cfg, null, { uidValiditySame: true }, now);
    assert.equal(cold.incremental, false);
    assert.equal(cold.days, 7);

    const fresh: ImapState = { uidValidity: '1', watermarkUid: 120, lastScanAt: new Date(now.getTime() - 60_000).toISOString() };
    const warm = scanWindow(cfg, fresh, { uidValiditySame: true }, now);
    assert.equal(warm.incremental, true);
    assert.equal(warm.days, 0);

    // 上次扫描在 3 小时前：增量窗口已过，退回 backfillDays，靠 message_id 幂等去重挡重复
    const stale: ImapState = { uidValidity: '1', watermarkUid: 120, lastScanAt: new Date(now.getTime() - 3 * 3600_000).toISOString() };
    assert.equal(scanWindow(cfg, stale, { uidValiditySame: true }, now).incremental, false);
  });

  it('uidValidity 变了必须作废水位并全量回溯，否则一批票会永久漏扫', () => {
    const now = new Date('2026-10-03T02:00:00Z');
    const moved: ImapState = { uidValidity: '2', watermarkUid: 120, lastScanAt: new Date(now.getTime() - 30_000).toISOString() };
    // 刚扫过但邮箱 uidValidity 变了 → 不敢走增量，退回 backfillDays
    assert.equal(scanWindow(cfg, moved, { uidValiditySame: false }, now).incremental, false);
    assert.equal(searchCriteria(cfg, moved, { uidValiditySame: false }, now).criteria.uid, undefined);
    // 同 uidValidity 且已过增量窗口才敢带 uid 区间（moved 是 30 秒前扫的，还属于增量窗口）
    const staleValid: ImapState = { uidValidity: '2', watermarkUid: 120, lastScanAt: new Date(now.getTime() - 4 * 3600_000).toISOString() };
    assert.equal(searchCriteria(cfg, staleValid, { uidValiditySame: true }, now).criteria.uid, '120:*');

    // 极端情况：只留 lastScanAt、uidValidity 丢了，当作首次见到这个邮箱
    const noValidity = { uidValidity: null, watermarkUid: 120, lastScanAt: new Date(now.getTime() - 30_000).toISOString() } as ImapState;
    assert.equal(scanWindow(cfg, noValidity, { uidValiditySame: false }, now).incremental, false);
  });

  it('只有非增量且水位有效时才带 uid 区间，避免漏掉新到的小 UID 邮件', () => {
    const now = new Date('2026-10-03T02:00:00Z');
    assert.equal(searchCriteria(cfg, null, { uidValiditySame: true }, now).criteria.uid, undefined);

    const withWater: ImapState = { uidValidity: '1', watermarkUid: 120, lastScanAt: new Date(now.getTime() - 10 * 3600_000).toISOString() };
    assert.equal(searchCriteria(cfg, withWater, { uidValiditySame: true }, now).criteria.uid, '120:*');

    // 刚扫过就不带 uid 区间了（靠 since + message_id 去重）
    const fresh: ImapState = { uidValidity: '1', watermarkUid: 120, lastScanAt: new Date(now.getTime() - 60_000).toISOString() };
    assert.equal(searchCriteria(cfg, fresh, { uidValiditySame: true }, now).criteria.uid, undefined);
  });

  it('水位文件能往返读写，写坏了宁可当没有也不崩', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'imap-state-')), 'state.json');
    const target = loadConfig({ ingest: { imap: { statePath: file } } });
    saveState(target, { uidValidity: 'abc', watermarkUid: 42, lastScanAt: '2026-10-03T02:00:00.000Z' });

    const back = loadState(target);
    assert.deepEqual(back, { uidValidity: 'abc', watermarkUid: 42, lastScanAt: '2026-10-03T02:00:00.000Z' });

    writeFileSync(file, '{ 这不是 json');
    assert.equal(loadState(target), null);
    assert.equal(loadState(loadConfig({ ingest: { imap: { statePath: path.join(tmpdir(), 'nope.json') } } })), null);
    assert.ok(readFileSync(file).length >= 0);
  });
});
