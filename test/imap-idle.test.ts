import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { loadConfig, resolvePaths } from '../src/config.js';
import { ImapSession, explainImapError } from '../src/imap.js';

/**
 * IDLE 的接线：`exists` 事件 → 唤醒循环，`close` → 让循环去重连。
 *
 * 真 Gmail 在 CI/沙箱里连不上，但这条线是整个「邮件到了立刻处理」的地基，
 * 不能只靠手测。注入假 ImapFlow（EventEmitter 就够）就能把它钉死。
 */
class FakeClient extends EventEmitter {
  authenticated = false;
  mailbox: unknown = false;
  connectCalls = 0;
  closeCalls = 0;
  /** 设了就让 connect() 抛它，用来模拟「连不上」：被限流、密码错、网络不通 */
  failWith: Error | null = null;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.failWith) throw this.failWith;
    this.authenticated = true;
    // 必须有 mailbox，ensureConnected 才认这条连接是活的
    this.mailbox = { path: 'INBOX', exists: 1, uidValidity: 1n };
  }

  async logout(): Promise<void> {
    this.authenticated = false;
    this.mailbox = false;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.authenticated = false;
    this.mailbox = false;
  }

  async list(): Promise<never[]> {
    return [];
  }
}

function makeSession(cfgOverrides: Parameters<typeof loadConfig>[0] = {}) {
  const fake = new FakeClient();
  const cfg = resolvePaths(
    loadConfig({
      ingest: {
        mode: 'imap',
        imap: { user: 'me@example.com', pass: 'app-password', idle: true },
      },
      ...cfgOverrides,
    }),
  );
  const session = new ImapSession(cfg, () => {}, () => fake as never);
  return { session, fake };
}

test('没人等待时到的推送不会被丢掉，下一次 waitForPush 立刻返回', async () => {
  const { session, fake } = makeSession();
  await session.ensureConnected();
  // 模拟「正在扫的时候来了新邮件」
  fake.emit('exists');
  assert.equal(await session.waitForPush(50), 'pushed', 'pendingPush 应该被消费掉');
  // 消费过之后就该老实等下一次
  assert.equal(await session.waitForPush(30), 'timeout');
});

test('等待过程中服务器推来新邮件：waitForPush 立刻醒，不等满', async () => {
  const { session, fake } = makeSession();
  await session.ensureConnected();
  const t0 = Date.now();
  const waiting = session.waitForPush(5000);
  setTimeout(() => fake.emit('exists'), 30);
  assert.equal(await waiting, 'pushed');
  assert.ok(Date.now() - t0 < 1000, '收到推送就该立刻返回，不要等满 5 秒');
});

test('等待过程中连接掉了：返回 dropped 让循环去退避重连', async () => {
  const { session, fake } = makeSession();
  await session.ensureConnected();
  const waiting = session.waitForPush(5000);
  setTimeout(() => fake.emit('close'), 30);
  assert.equal(await waiting, 'dropped');
});

test('连接断了且没人在等：下一次 waitForPush 也认得出，不会假装在听', async () => {
  const { session, fake } = makeSession();
  await session.ensureConnected();
  fake.emit('close');
  assert.equal(await session.waitForPush(50), 'dropped');
});

test('等待期间被 disconnect：不能干等到超时', async () => {
  const { session } = makeSession();
  // 必须先连上：没连过时的 disconnect 是 no-op，那是另一回事（循环里每轮都先跑一遍收件，
  // 真正进入等待时连接一定是活的）
  await session.ensureConnected();
  const waiting = session.waitForPush(5000);
  const t0 = Date.now();
  await session.disconnect();
  assert.equal(await waiting, 'dropped');
  assert.ok(Date.now() - t0 < 1000, 'disconnect 应该主动唤醒等待方');
});

test('idle 关掉时明确 disableAutoIdle，别让长连接偷偷进 IDLE', async () => {  const cfg = resolvePaths(
    loadConfig({ ingest: { mode: 'imap', imap: { user: 'me@example.com', pass: 'x', idle: false } } }),
  );
  let seen: Record<string, unknown> | null = null;
  const fake = new FakeClient();
  const session = new ImapSession(
    cfg,
    () => {},
    (options) => {
      seen = options as unknown as Record<string, unknown>;
      return fake as never;
    },
  );
  await session.ensureConnected();
  assert.equal(seen?.['disableAutoIdle'], true);
  assert.equal(seen?.['maxIdleTime'], cfg.ingest.imap.maxIdleTimeMs, 'maxIdleTime 要传下去，靠它定期重进 IDLE');
});

/**
 * 建连失败这件事以前是「悄悄漏掉」的：失败的 ImapFlow 会被我们丢掉，但它的 socket
 * 和监听器还活着（lsof 里能看到一条 CLOSED 状态的连接挂一辈子），而且它的 close 事件
 * 会让 waitForPush 以为「连接断了」却又不记录，下一轮就多连一次——
 * 重连次数翻倍，而这正是触发服务端限流的那件事。
 */
test('建连失败：清掉废连接，并记住「断了」，同一轮里不再连第二次', async () => {
  const { session, fake } = makeSession();
  fake.failWith = Object.assign(
    new Error('Client network socket disconnected before secure TLS connection was established'),
    { code: 'ECONNRESET' },
  );

  await assert.rejects(() => session.ensureConnected(), /TLS connection/);
  assert.equal(fake.connectCalls, 1);
  assert.equal(fake.closeCalls, 1, '失败的 client 要显式关掉，别留半开的 socket 和监听器');

  assert.equal(
    await session.waitForPush(50),
    'dropped',
    '失败要记成「断了」：否则等待方会拿一条刚失败的连接在同一轮里再连一次',
  );
  assert.equal(fake.connectCalls, 1, '同一轮里只能有一次连接尝试');
});

/**
 * 「连不上」至少有四种完全不同的原因，处理方向差得很远：
 * 被限流要做的是**停手**，密码错要人去改 App Password，网络挡端口要去看防火墙。
 * 只会甩一句 ECONNRESET 的话，人对着它只会往错的方向修。
 */
test('连不上的四种原因要能被区分开，认不出来就不猜', () => {
  const err = (message: string, code: string) => Object.assign(new Error(message), { code });

  assert.match(
    explainImapError(err('Client network socket disconnected before secure TLS connection was established', 'ECONNRESET')),
    /限流/,
  );
  assert.match(explainImapError(err('Invalid credentials (Failure)', 'AUTHENTICATIONFAILED')), /应用专用密码/);
  assert.match(explainImapError(err('getaddrinfo ENOTFOUND imap.gmail.com', 'ENOTFOUND')), /域名解析/);
  assert.match(explainImapError(err('connect ETIMEDOUT 108.177.125.109:993', 'ETIMEDOUT')), /993/);
  assert.match(explainImapError(new Error('NO [LIMIT] Too many simultaneous connections')), /同时连接数/);
  assert.equal(explainImapError(new Error('某种没见过的失败')), '', '认不出来就别猜，返回空串让调用方自己决定');
  assert.equal(explainImapError(undefined), '', '连 Error 都不是也不能炸');
});
