import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, resolvePaths } from '../src/config.js';
import { open } from '../src/db.js';
import { nextCycleDelay, startAutoPipeline } from '../src/pipeline.js';

const root = path.resolve(import.meta.dirname, '..');
const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

test('IDLE 的下一轮等待时间：推送立刻跑，断线走退避，超时回兜底间隔', () => {
  const poll = 300_000;
  const backoff = [2000, 10000, 30000];
  // 抖动关掉（0.5 → 系数正好 1.0）才能断言精确数字；抖动本身另有用例
  const fixed = () => 0.5;

  assert.equal(
    nextCycleDelay({ idle: false, outcome: 'off', pollIntervalMs: poll, reconnectBackoffMs: backoff }),
    poll,
  );
  // 服务器推来新邮件：立刻跑（留 300ms 让连着的几个 EXISTS 攒一起）
  assert.equal(
    nextCycleDelay({ idle: true, outcome: 'pushed', pollIntervalMs: poll, reconnectBackoffMs: backoff }),
    300,
  );
  // 等到上限也没邮件：回到兜底轮询。IDLE 只是加速，不是唯一路径
  assert.equal(
    nextCycleDelay({ idle: true, outcome: 'timeout', pollIntervalMs: poll, reconnectBackoffMs: backoff }),
    poll,
  );
  // 连接掉了：按退避第一档重连，绝不能立刻冲（否则连不上时就是死循环）
  assert.equal(
    nextCycleDelay({ idle: true, outcome: 'dropped', pollIntervalMs: poll, reconnectBackoffMs: backoff, random: fixed }),
    2000,
  );
  // 连着掉：间隔要一步步拉开，最后一档封顶（凭证错时别 2 秒捶一次 Gmail）
  assert.equal(
    nextCycleDelay({
      idle: true,
      outcome: 'dropped',
      pollIntervalMs: poll,
      reconnectBackoffMs: backoff,
      dropStreak: 2,
      random: fixed,
    }),
    10000,
  );
  assert.equal(
    nextCycleDelay({
      idle: true,
      outcome: 'dropped',
      pollIntervalMs: poll,
      reconnectBackoffMs: backoff,
      dropStreak: 99,
      random: fixed,
    }),
    30000,
    '超过退避表长度就停在最后一档，不能越界',
  );
  assert.equal(
    nextCycleDelay({ idle: true, outcome: 'dropped', pollIntervalMs: poll, reconnectBackoffMs: [], random: fixed }),
    2000,
    '退避表是空的也要有个兜底值，不能返回 0',
  );
  // 掉线之后恢复正常（超时/推送）要把计数清掉，否则下一次偶发抖动直接吃最大间隔
  assert.equal(
    nextCycleDelay({
      idle: true,
      outcome: 'timeout',
      pollIntervalMs: poll,
      reconnectBackoffMs: backoff,
      dropStreak: 3,
    }),
    poll,
  );
});

/**
 * 退避要带抖动。两个 watch 同时连同一个邮箱时，如果退避踩在同一个节拍上，
 * 它们会一起撞服务端、一起被限流、再一起退避——退避就等于没做。
 */
test('重连退避带 ±15% 抖动，且不会抖到离谱的值', () => {
  const o = { idle: true, outcome: 'dropped' as const, pollIntervalMs: 300_000, reconnectBackoffMs: [1000, 60_000] };
  assert.equal(nextCycleDelay({ ...o, random: () => 0 }), 850, '下界');
  assert.equal(nextCycleDelay({ ...o, random: () => 1 }), 1150, '上界');
  assert.equal(nextCycleDelay({ ...o, random: () => 0.5 }), 1000, '中间不动');

  const capped = nextCycleDelay({ ...o, dropStreak: 50, random: () => 0 });
  assert.equal(capped, 51_000, '封顶那一档同样只抖 ±15%，不会抖回秒级');
});

/**
 * 这条是这次线上翻车的回归测试：`watch` 连不上邮箱时曾经按 2s/10s/30s 无限循环地重连，
 * 30 秒一次就足以让 Gmail 认为在刷它，于是 TLS 握手被持续 ECONNRESET——
 * 而且每次重试都在给惩罚续期，越撞越连不上。
 * 所以配置里的退避阶梯必须**长到分钟级**，让「停手等它过期」真的有机会发生。
 */
test('默认配置的重连退避要长到分钟级，不能一直 30 秒捶服务端', () => {
  const ladder = resolvePaths(loadConfig()).ingest.imap.reconnectBackoffMs;
  assert.ok(ladder.length >= 4, `退避阶梯至少要有 4 档，现在是 ${JSON.stringify(ladder)}`);
  const last = ladder[ladder.length - 1] ?? 0;
  assert.ok(last >= 300_000, `最后一档要 ≥ 5 分钟，现在是 ${String(last)}ms`);
  // 单调不减：乱序的阶梯会让「越掉越久」这件事不成立
  for (let i = 1; i < ladder.length; i += 1) {
    assert.ok((ladder[i] ?? 0) >= (ladder[i - 1] ?? 0), '退避阶梯必须单调不减');
  }
});

/**
 * 「后台已启动」不能只是一句台词。
 *
 * 定时器一旦 unref，首轮结束后事件循环就空了，进程会安静退出、而屏幕上还写着「已启动，Ctrl+C 退出」。
 * 这里断言两件事：keepAlive 的循环确实挂着一个 ref 状态的 Timeout（这正是撑住常驻进程的东西），
 * stop() 之后它必须消失（否则 Ctrl+C 之后句柄还在，`--once` 之类也会被吊住）。
 */
test('keepAlive 的循环挂着定时器，stop() 能摘掉', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fetchnow-watch-'));
  tmpDirs.push(dir);
  const config = resolvePaths(
    loadConfig({
      ingest: {
        mode: 'folder',
        folder: { path: path.join(root, 'fixtures/inbox') },
        pollIntervalMs: 600000,
      },
      storage: { dir: path.join(dir, 'data') },
    }),
  );
  const handle = open(config);
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const timeouts = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const before = timeouts();

  const stop = startAutoPipeline(handle, () => {}, { keepAlive: true });
  // 首轮是异步跑的（要读目录、写库），等那个定时器挂上来
  const deadline = Date.now() + 5000;
  while (timeouts() <= before && Date.now() < deadline) await delay(20);
  assert.ok(timeouts() > before, 'keepAlive 的循环应该挂着一个 ref 状态的定时器撑住进程');

  stop();
  assert.equal(timeouts(), before, 'stop() 之后不该再有循环定时器');
  handle.db.close();
});
