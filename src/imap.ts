/**
 * IMAP 收件层。
 *
 * 这一层只回答一个问题：「从邮箱里把还没见过的原始邮件取出来」。取出来之后
 * 认不认它是发票，是 `ingest.ts` + 人的判断的事。
 *
 * 真实邮箱里四个一定会咬人的点：
 * 1. `seq` 会因为别的客户端收/删邮件而变化，只有 `uid` + `uidValidity` 稳定；
 *    换邮箱客户端、邮件服务端重整都会改 uidValidity，此时旧水位必须作废（否则一批票永久漏扫）；
 * 2. `BODY.PEEK[]` 而不是 `RFC822`：后者会顺手把邮件标成已读，发票还没人看过就"已读"了；
 * 3. 服务器约 29 分钟掐空闲连接，而且多数是**静默**掐（不报错、不返回 BYE）；
 *    所以别指望一条长连接活着——每次扫描都先 `ensureConnected()` 探一下；
 * 4. 用 `since` 搜索而不是 `UNSEEN`：`UNSEEN` 是我们自己进程的状态，别的端（手机、网页）一读就清零，
 *    对账的时候对不上账。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { Config, ImapConfig } from './config.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP 的 SINCE 要 `01-Jan-2026` 这种写法，Gmail 对格式格外严格，UTC 而不是本地时区 */
export function imapDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[d.getUTCMonth()];
  const yyyy = String(d.getUTCFullYear());
  return `${dd}-${mon}-${yyyy}`;
}

/**
 * 把「连不上」翻成人话。同一个 `Client network socket disconnected before secure TLS connection`
 * 表面下至少藏着四种完全不同的原因，处理方式差得很远：
 * 密码错要人去改 App Password，被限流则该做的是「别再去连」——方向反了就永远好不了。
 *
 * 只按 `code` / `message` 认，不认 `instanceof`：这些错误分别从 `node:tls`、`node:net`、
 * imapflow 三处冒出来，类各不相同，稳定的是 code 和文本。认不出来就返回空串，
 * 由调用方决定要不要多打一行——宁可少说，也不猜。
 *
 * 每条都压成一行：这句话会跟着失败反复出现，太长就变成刷屏。
 */
export function explainImapError(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = String(e.code ?? '');
  const message = String(e.message ?? err ?? '');
  const text = `${code} ${message}`;

  if (
    /ECONNRESET|EPIPE/.test(code) ||
    /socket disconnected before secure TLS connection|ECONNRESET|EPIPE/i.test(message)
  ) {
    return '像是服务端限流：TLS 握手被重置，且重连越频繁惩罚续得越久——停手等几分钟到十几分钟，别开第二个进程连同一个邮箱';
  }
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|Authentication failed/i.test(text)) {
    return '账号或密码不对：FN_IMAP_PASS 要填 16 位「应用专用密码」，不是登录密码（前置是账号已开两步验证）';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    return '域名解析不出来：检查 FN_IMAP_HOST 拼写，以及当前网络的 DNS';
  }
  if (
    /ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|GREETING_TIMEOUT|CONNECT_TIMEOUT/.test(code) ||
    /timeout/i.test(message)
  ) {
    return 'TCP 没通：993 被网络/防火墙/VPN 挡了（先 `nc -vz imap.gmail.com 993` 确认）';
  }
  if (/LIMIT|too many simultaneous|Too many/i.test(message)) {
    return 'IMAP 同时连接数超了（Gmail 上限 15 个）：关掉多余的客户端，或另一个还在跑的本进程';
  }
  return '';
}

export function maxUid(uids: readonly number[]): number | null {
  let max: number | null = null;
  for (const u of uids) if (u > 0 && (max === null || u > max)) max = u;
  return max;
}

export interface ImapState {
  /** 邮箱的 uidValidity：变了说明 uid 全部重排，水位不再可信 */
  uidValidity: string | null;
  watermarkUid: number | null;
  lastScanAt: string;
}

export function loadState(cfg: Config): ImapState | null {
  const file = statePath(cfg);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ImapState>;
    if (typeof raw.lastScanAt !== 'string') return null;
    return {
      uidValidity: raw.uidValidity ?? null,
      watermarkUid: typeof raw.watermarkUid === 'number' ? raw.watermarkUid : null,
      lastScanAt: raw.lastScanAt,
    };
  } catch {
    return null;
  }
}

export function saveState(cfg: Config, state: ImapState): void {
  const file = statePath(cfg);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  // 顺手收窄权限，别让 data 目录整体可写
  chmodSync(file, 0o600);
}

function statePath(cfg: Config): string {
  return path.resolve(process.cwd(), cfg.ingest.imap.statePath);
}

/**
 * 决定这次扫多久：
 * - 冷启动 / 距上次扫描超过增量窗口 → 回溯 backfillDays（宁可多拉几封，让 message_id 幂等去重去挡）
 * - 刚扫过 → 只扫增量窗口，省掉大量重复 fetch
 */
export function scanWindow(cfg: Config, state: ImapState | null, options: { uidValiditySame: boolean }, now = new Date()) {
  const im = cfg.ingest.imap;
  const fresh = state?.lastScanAt
    ? now.getTime() - Date.parse(state.lastScanAt) < im.incrementalWindowMinutes * 60_000
    : false;
  const incremental = Boolean(state) && options.uidValiditySame && fresh;
  const days = incremental ? 0 : im.backfillDays;
  return { since: new Date(now.getTime() - days * 86_400_000), incremental, days };
}

/**
 * imapflow 的 search criteria。
 * `uidValiditySame` 由调用方拿服务端返回的 uidValidity 与水位比对后传入——
 * uidValidity 一变，旧 uid 区间必须整个作废，否则「新邮箱的第一批邮件永远扫不到」。
 */
export function searchCriteria(
  cfg: Config,
  state: ImapState | null,
  options: { uidValiditySame: boolean },
  now = new Date(),
) {
  const { since, incremental } = scanWindow(cfg, state, options, now);
  const watermark = state?.watermarkUid ?? null;
  const useWatermark = options.uidValiditySame && !incremental && (watermark ?? 0) > 0;
  const criteria: Record<string, string | Date> = { since };
  if (useWatermark && watermark !== null) criteria.uid = `${watermark}:*`;
  return { criteria, since, incremental, watermark };
}

export interface FetchedMessage {
  uid: number;
  source: Buffer;
}

/** IDLE 等待的三种结局：服务器推来新邮件 / 等到上限没事发生 / 连接掉了 */
export type ImapIdleOutcome = 'pushed' | 'timeout' | 'dropped';

export class ImapSession {
  private client: ImapFlow | null = null;
  /** 服务器推来新邮件时置位。可能在没人等待的时候发生（比如正在扫），所以要先记下来 */
  private pendingPush = false;
  /** 连接掉了同样可能发生在没人在等的时候 */
  private pendingDrop = false;
  private waiters = new Set<(outcome: Exclude<ImapIdleOutcome, 'timeout'>) => void>();

  constructor(
    private readonly cfg: Config,
    private readonly logger: (msg: string) => void = () => {},
    /**
     * 建连接的工厂，只为测试留的缝：IDLE 的正确性全押在「`exists` 事件 → 唤醒循环」这条线上，
     * 而它没法对着真 Gmail 在 CI 里验。测试注入一个假的 ImapFlow（EventEmitter 就够），
     * 就能把「推送唤醒 / 断线唤醒 / 超时」三种结局都锁住。
     */
    private readonly makeClient: (options: ImapFlowOptions) => ImapFlow = (o) => new ImapFlow(o),
  ) {}

  /**
   * IDLE 到底怎么实现的：**交给 imapflow 自己**。
   *
   * imapflow ≥2 在有已选中邮箱、且连接空闲 15 秒后会自动进入 IDLE（`autoIdleDelay`），
   * 空闲超过 `maxIdleTime` 会自动 DONE 再重新进入——正好绕开服务器约 29 分钟静默掐空闲连接
   * 那件事。所以我们要做的只有两件：把连接**留着别关**，然后听 `exists` 事件。
   *
   * `disableAutoIdle` 由 `ingest.imap.idle` 决定：不打算用 IDLE 时明确关掉，
   * 免得一个长连接在两次扫描之间偷偷进 IDLE 又被打断，多出无谓的 IDLE/DONE 往返。
   */
  private autoIdleOptions(): { disableAutoIdle: boolean } {
    return { disableAutoIdle: !this.cfg.ingest.imap.idle };
  }

  /** 每次扫描前调：连接活着就用，死了（静默掐断、睡眠唤醒、网络抖）就重连 */
  async ensureConnected(): Promise<ImapFlow> {
    // mailbox 有值 = 已经 select 过且会话还活着；imapflow 不会告诉我们「静默断线」，只能这样探
    const live = this.client && this.client.authenticated && this.client.mailbox;
    if (live) return this.client as ImapFlow;
    await this.disconnect();
    const im = this.cfg.ingest.imap;
    if (!im.user) {
      throw new Error('邮箱账号是空的：在项目根目录的 .env 里填 FN_IMAP_USER（完整邮箱地址）和 FN_IMAP_PASS（16 位应用专用密码），或直接 export 这两个变量');
    }
    const auth = im.authMethod === 'oauth'
      ? { user: im.user, accessToken: im.pass }
      : { user: im.user, pass: im.pass };

    this.logger(`连接 ${im.host}:${im.port}（用户 ${mask(im.user)}）`);
    const client = this.makeClient({
      host: im.host,
      port: im.port,
      secure: im.secure,
      auth,
      // 每隔 maxIdleTime 自动断开 IDLE 再重进，别等服务器那~29 分钟的静默掐线
      maxIdleTime: im.maxIdleTimeMs,
      connectionTimeout: im.connectionTimeoutMs,
      ...this.autoIdleOptions(),
      logger: false,
    });
    // 关键：imapflow 自己不会在断线后重连，连接静默死掉时我们必须把引用清掉，
    // 否则下一次扫描会拿着一个「以为还活着」的 client 直接失败
    const onClose = () => {
      this.pendingDrop = true;
      this.notify('dropped');
      this.logger('IMAP 连接已关闭，下次扫描会重连');
    };
    // 这一条是 IDLE 的唯一入口：收到 EXISTS 就说明有新邮件
    const onExists = () => {
      this.pendingPush = true;
      this.notify('pushed');
    };
    client.on('close', onClose);
    client.on('exists', onExists);
    try {
      await client.connect();
    } catch (err) {
      // 连接没成，这条 client 就废了，但它可能还留着半开的 socket（lsof 里能看到一条
      // CLOSED 状态的连接挂一辈子）。显式关掉，并把它的 close 监听摘掉：
      // 「断了」这件事由我们自己记（下面的 pendingDrop）——否则 waitForPush 会以为还要等连接事件，
      // 然后拿一条刚失败的连接在**同一轮里再连一次**：重连次数直接翻倍，
      // 而这正是触发服务端限流的那件事。
      client.removeListener('close', onClose);
      this.pendingDrop = true;
      try {
        await client.close();
      } catch {
        /* 握手就没成的时候 close 也会抛，忽略 */
      }
      throw err;
    }
    this.client = client;
    return client;
  }

  async listMailboxes(): Promise<string[]> {
    const client = await this.ensureConnected();
    const list = await client.list();
    return list.map((m) => m.path);
  }

  /** 只读探活：`imap check` 用。不写水位、不入库，连不通就打印人话原因 */
  async probe(): Promise<{ mailboxes: string[]; selected: string | null; exists: number; uidValidity: string | null; since: string }> {
    const client = await this.ensureConnected();
    const { since } = scanWindow(this.cfg, null, { uidValiditySame: true });
    let selected: string | null = null;
    let exists = 0;
    let uidValidity: string | null = null;
    try {
      const lock = await client.getMailboxLock(this.cfg.ingest.imap.mailbox);
      try {
        selected = lock.path;
        exists = typeof client.mailbox === 'object' && client.mailbox ? client.mailbox.exists : 0;
        uidValidity = currentUidValidity(client);
      } finally {
        lock.release();
      }
    } catch (err) {
      throw new Error(`打不开邮箱 ${this.cfg.ingest.imap.mailbox}：${err instanceof Error ? err.message : String(err)}`);
    }
    return {
      mailboxes: (await client.list()).map((m) => m.path),
      selected,
      exists,
      uidValidity,
      since: imapDate(since),
    };
  }

  /** 扫一遍并返回原始邮件；uidValidity 变了会重扫并作废旧水位 */
  async scan(now = new Date()): Promise<{ messages: FetchedMessage[]; validityChanged: boolean; uidValidity: string | null }> {
    const cfg = this.cfg;
    const im = cfg.ingest.imap;
    const client = await this.ensureConnected();

    const before = loadState(cfg);

    let lock: { release(): void } | null = null;
    try {
      lock = await client.getMailboxLock(im.mailbox);
    } catch (err) {
      throw new Error(`打不开邮箱 ${im.mailbox}：${err instanceof Error ? err.message : String(err)}（Gmail 注意：IMAP 里标签不等于文件夹，Google Workspace 才有真正的标签/文件夹区分）`);
    }
    try {
      // uidValidity 只有选中邮箱之后才有值，必须先 select 才能和水位比对
      const uidValidity = currentUidValidity(client);
      const compared = before?.uidValidity ?? null;
      const uidValiditySame = compared == null || compared === uidValidity;
      const validityChanged = compared != null && compared !== uidValidity;
      if (validityChanged) this.logger(`uidValidity ${compared} → ${uidValidity}：旧 UID 水位作废，改全量回溯`);
      const { criteria } = searchCriteria(cfg, before, { uidValiditySame }, now);
      const ids = (await client.search(criteria as never)) as number[];
      const uids = ids.map((n) => n);
      const messages: FetchedMessage[] = [];
      // BODY.PEEK[] 而不是 RFC822：PEEK 不置 \Seen，发票先让人看再标记
      for await (const msg of client.fetch(uids, { uid: true, source: true })) {
        messages.push({ uid: Number(msg.uid ?? 0), source: Buffer.from(msg.source as Uint8Array) });
      }
      messages.sort((a, b) => a.uid - b.uid);

      const freshMax = messages.length ? maxUid(messages.map((m) => m.uid)) : null;
      const state: ImapState = {
        uidValidity,
        // 本轮没拉到东西就别把水位往下推，否则下次可能永久漏掉新到的邮件
        watermarkUid: freshMax ?? before?.watermarkUid ?? null,
        lastScanAt: now.toISOString(),
      };
      saveState(cfg, state);
      return { messages, validityChanged, uidValidity };
    } finally {
      lock.release();
    }
  }

  /**
   * 等一次服务器推送，最多等 ms 毫秒。
   *
   * **不要在这里手动调 `client.idle()`**：imapflow 的 `idle()` 要等这一轮 IDLE 结束才 resolve，
   * 拿 `Promise.race` 加个超时只是「我们不等了」，连接仍然留在 IDLE 里，下一轮 select 还得先把它撬开。
   * 交给 imapflow 的 auto-IDLE，我们只消费 `exists` 事件。
   *
   * 返回 'timeout' 时连接是好的、只是这段时间没有新邮件（调用方按兜底轮询间隔再来一次）；
   * 返回 'dropped' 时连接断了（调用方要退避一下再重连，别原地打转）。
   */
  async waitForPush(ms: number): Promise<ImapIdleOutcome> {
    if (this.pendingPush) {
      this.pendingPush = false;
      return 'pushed';
    }
    if (this.pendingDrop) {
      this.pendingDrop = false;
      return 'dropped';
    }
    // 惰性建连：连不上会直接抛，交给调用方按「断了」处理并退避
    await this.ensureConnected();
    // 建连/重连这段时间里可能已经有推送或掉线，再认一次，别白等一整轮
    if (this.pendingPush) {
      this.pendingPush = false;
      return 'pushed';
    }
    if (this.pendingDrop) {
      this.pendingDrop = false;
      return 'dropped';
    }
    return new Promise<ImapIdleOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: ImapIdleOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(onEvent);
        resolve(outcome);
      };
      // 不用箭头函数存引用就没法 delete，所以这里留一个具名引用
      const onEvent = (outcome: Exclude<ImapIdleOutcome, 'timeout'>) => finish(outcome);
      this.waiters.add(onEvent);
      // 这个计时器**不能 unref**：unref 的定时器不撑事件循环，一旦外面没有别的 ref 句柄，
      // 进程会在等待中途排空退出，而等待方永远等不到 resolve（真事，测试里就是这么挂住的）。
      // 进程存活与否由外层循环定时器的 keepAlive 决定，这一层只管等待本身。
      const timer = setTimeout(() => finish('timeout'), ms);
    });
  }

  private notify(outcome: Exclude<ImapIdleOutcome, 'timeout'>): void {
    for (const w of [...this.waiters]) {
      try {
        w(outcome);
      } catch {
        /* 等待方自己的异常不该拖垮事件回调 */
      }
    }
  }

  isConnected(): boolean {
    return Boolean(this.client?.authenticated && this.client?.mailbox);
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    // 正在等推送的循环不能就这么干等到超时，明确告诉它「连接没了」
    this.pendingDrop = true;
    this.notify('dropped');
    try {
      await client.logout();
    } catch {
      /* 断线时 logout 会抛，忽略 */
    }
  }
}

/** select 之后才有 mailbox；imapflow 用 false 表示「还没选中」 */
function currentUidValidity(client: ImapFlow): string | null {
  const mb = client.mailbox;
  if (!mb || typeof mb === 'boolean') return null;
  return mb.uidValidity != null ? String(mb.uidValidity) : null;
}

const mask = (s: string): string => (s.includes('@') ? s.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '***');
