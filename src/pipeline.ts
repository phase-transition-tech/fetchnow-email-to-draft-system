import type { Config } from './config.js';
import { dueInvoices, getInvoice, listInvoices, recordEvent, updateInvoice, type DbHandle } from './db.js';
import { ImapSession, explainImapError, type ImapIdleOutcome } from './imap.js';
import { senderAddr } from './ingest.js';
import { extractInvoice } from './extract.js';
import { runIngest } from './ingest.js';
import type { InvoiceFields, XeroAdapter } from './types.js';
import { createAdapter } from './xero.js';
import { validate } from './validate.js';

export interface ProcessSummary {
  processed: number;
  created: number;
  review: number;
  retried: number;
  dead: number;
  /** 已经建过单又被重新入队的任务：直接还原状态，不再发第二个建单请求 */
  skipped: number;
}

export function ingestOnce(handle: DbHandle, options: { session?: ImapSession } = {}) {
  return runIngest(handle, options);
}

export function admitInvoice(handle: DbHandle, id: number): 'ok' | 'already' {
  const row = getInvoice(handle.db, id);
  if (!row) return 'already';
  if (row.status === 'observed') {
    updateInvoice(handle.db, id, { status: 'admitted' });
    recordEvent(handle.db, id, 'info', '人工确认纳入处理队列');
    return 'ok';
  }
  return 'already';
}

/**
 * 自动纳入：发件人在 review.autoAdmitDomains 里的，邮件一进来就直接推进处理队列，
 * 不用人点 admit。其余的仍然停在「待开票输入」面板等人确认。
 *
 * 列表为空 = 完全不自动（默认）。命中判定两种写法都吃：
 *   "self@foxmail.com"  精确地址
 *   "foxmail.com"       域名，且只判「@ 之后」（不会把别人的 sub.foxmail.com 也放进来）
 */
export function autoAdmitTrusted(handle: DbHandle): { admitted: number; pending: number } {
  const { db, config } = handle;
  const trusted = config.review.autoAdmitDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  const pendingRows = listInvoices(db, 'observed');
  if (trusted.length === 0) return { admitted: 0, pending: pendingRows.length };

  let admitted = 0;
  for (const row of pendingRows) {
    const addr = senderAddr(String(row.from_addr ?? ''));
    if (!addr) continue;
    const hit = trusted.some((d) => (d.includes('@') ? addr === d : addr.endsWith(`@${d}`) || addr === d));
    if (!hit) continue;
    if (admitInvoice(handle, Number(row.id)) === 'ok') {
      recordEvent(db, Number(row.id), 'info', '白名单命中，自动纳入处理队列', `from=${addr}`);
      admitted += 1;
    }
  }
  return { admitted, pending: pendingRows.length - admitted };
}

export function retryInvoice(handle: DbHandle, id: number): void {
  updateInvoice(handle.db, id, { status: 'retry', due_at: null, last_error: null });
}

function countSameInvoiceNo(db: DbHandle['db'], invoiceNo: string | null, exceptId: number): number {
  if (!invoiceNo) return 0;
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM invoices WHERE invoice_no = ? AND id != ?')
    .get(invoiceNo, exceptId) as { c: number } | undefined;
  return row?.c ?? 0;
}

/** 串行消费：一天几张票，串行既是 Xero 限流的要求，也让「同附件不重复建单」更容易推理 */
export async function processOnce(
  handle: DbHandle,
  options: { adapter?: XeroAdapter } = {},
): Promise<ProcessSummary> {
  const { db, config } = handle;
  const adapter = options.adapter ?? createAdapter(config);
  const summary: ProcessSummary = { processed: 0, created: 0, review: 0, retried: 0, dead: 0, skipped: 0 };

  const rows = dueInvoices(db, Math.max(config.worker.concurrency, 1));
  for (const row of rows) {
    const id = Number(row.id);
    // 结果层兜底：人点了「重新处理」，但这张票已经建过草稿，直接还原，不重复 POST
    if (row.provider_ref) {
      updateInvoice(db, id, { status: 'created' });
      recordEvent(db, id, 'info', '已存在草稿，跳过重复建单', `provider_ref=${String(row.provider_ref)}`);
      summary.skipped += 1;
      continue;
    }
    const attempt = Number(row.attempt_count ?? 0) + 1;
    summary.processed += 1;
    updateInvoice(db, id, { status: 'extracting', attempt_count: attempt });
    recordEvent(db, id, 'info', `开始处理（第 ${attempt} 次）`);

    try {
      const { fields } = await extractInvoice(String(row.raw_path), config);
      const duplicateInvoiceNo = countSameInvoiceNo(db, fields.invoiceNo.value, id) > 0;
      const { flags, shouldCreateDraft } = validate(fields, config, { duplicateInvoiceNo });

      updateInvoice(db, id, {
        vendor: fields.vendor.value,
        invoice_no: fields.invoiceNo.value,
        issue_date: fields.issueDate.value,
        due_date: fields.dueDate.value,
        currency: fields.currency.value,
        subtotal: fields.subtotal.value,
        tax: fields.tax.value,
        total: fields.total.value,
        tax_type: fields.taxType,
        line_items: JSON.stringify(fields.lineItems),
        extracted: JSON.stringify(fields),
        flags: JSON.stringify(flags.map((f) => f.code)),
        confidence: JSON.stringify(confidenceMap(fields)),
      });

      if (!shouldCreateDraft) {
        updateInvoice(db, id, { status: 'review' });
        recordEvent(db, id, 'warn', '转人工复核', flags.map((f) => `${f.code}:${f.message}`).join(' | '));
        summary.review += 1;
        continue;
      }

      const result = await adapter.createDraftBill({
        vendor: fields.vendor.value ?? '未知供应商',
        invoiceNo: fields.invoiceNo.value ?? 'UNKNOWN',
        issueDate: fields.issueDate.value ?? new Date().toISOString().slice(0, 10),
        dueDate: fields.dueDate.value,
        currency: fields.currency.value ?? config.extract.defaultCurrency,
        lineAmountTypes: fields.taxType,
        lineItems: fields.lineItems,
        tax: fields.tax.value ?? 0,
        total: fields.total.value ?? 0,
        taxCode: config.xero.defaultTaxCode,
        accountCode: config.xero.defaultAccountCode,
        attachmentPath: String(row.raw_path),
        attachmentFilename: String(row.filename ?? 'invoice.pdf'),
        sourceMessageId: String(row.message_id),
      });
      updateInvoice(db, id, { status: 'created', provider: result.provider, provider_ref: result.billId });
      recordEvent(db, id, 'info', `已建 Xero 草稿 ${result.billId}`, `status=${result.status}`);
      summary.created += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordEvent(db, id, 'error', `处理失败：${message}`);
      if (attempt >= config.worker.maxAttempts) {
        updateInvoice(db, id, { status: 'dead', last_error: message });
        recordEvent(db, id, 'error', '达到最大重试次数，进入死信队列');
        summary.dead += 1;
      } else {
        const delay = config.worker.backoffMs[Math.min(attempt - 1, config.worker.backoffMs.length - 1)] ?? 5000;
        updateInvoice(db, id, { status: 'retry', last_error: message, due_at: new Date(Date.now() + delay).toISOString() });
        summary.retried += 1;
      }
    }
  }
  return summary;
}

function confidenceMap(fields: InvoiceFields): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries<unknown>(fields as unknown as Record<string, unknown>)) {
    if (value && typeof value === 'object' && 'confidence' in (value as object)) {
      out[key] = String((value as { confidence: string }).confidence);
    }
  }
  return out;
}

/**
 * 一轮完整自动闭环：收件 → 白名单自动纳入 → 处理。
 * 单进程单循环，比「另开两个终端分别跑 scan --watch / process --watch」好管得多：
 * 一个 Ctrl+C 全停，也不会有两条 sqlite 连接互相抢写。
 */
export async function runAutoCycle(handle: DbHandle, options: { session?: ImapSession } = {}): Promise<void> {
  const ingest = await ingestOnce(handle, options);
  if (ingest.inserted > 0 || ingest.filtered > 0) {
    console.log(
      `扫描 ${ingest.scanned} 封：新入库 ${ingest.inserted}，重复 ${ingest.duplicates}，被过滤 ${ingest.filtered}`,
    );
  }
  const auto = autoAdmitTrusted(handle);
  if (auto.admitted > 0) console.log(`自动纳入（白名单命中）：${auto.admitted} 条，仍在等人工确认 ${auto.pending} 条`);
  const work = await processOnce(handle);
  if (work.processed > 0) {
    console.log(
      `处理 ${work.processed} 条：建草稿 ${work.created}，转人工 ${work.review}，重试 ${work.retried}，死信 ${work.dead}，跳过 ${work.skipped}`,
    );
  }
}

/**
 * 下一轮该等多久——抽成纯函数，好让「IDLE 到底省了多少等待」能被测试断言，不用真连邮箱。
 *
 * - IDLE 关着：老老实实按兜底轮询间隔
 * - 服务器推来了：300ms 就去（一次收几封邮件会连着来好几个 EXISTS，稍微攒一下）
 * - 等待超时：说明这段时间确实没邮件，回到兜底间隔
 * - 连接掉了：按重连退避的档位去重连，**不能立刻冲**，否则连不上时就是一个死循环
 *
 * 掉线的退避档位是这张表的意义所在：连不上时如果一直按 30 秒捶一次，服务端的限流会
 * 被每一次重试不断续期，永远好不了。表尾那几档（分钟级）就是留给这种情况的——
 * 退避拉到分钟级之后，「等它自己过期」才有机会发生。
 */
export function nextCycleDelay(o: {
  idle: boolean;
  outcome: ImapIdleOutcome | 'off';
  pollIntervalMs: number;
  reconnectBackoffMs: number[];
  /** 连续掉线次数（1 起）；一次掉线是意外，连着掉就是密码错/被限流/网络不通，该拉长间隔 */
  dropStreak?: number;
  /**
   * 抖动用的随机源，默认 Math.random；测试注入固定值才能断言精确数字。
   * 为什么要抖：两个 watch 同时连同一个邮箱时，退避不能踩在同一个节拍上——
   * 否则它们会一起撞服务端、一起被限流、再一起退避，退避就白做了。
   */
  random?: () => number;
}): number {
  if (!o.idle || o.outcome === 'off') return o.pollIntervalMs;
  if (o.outcome === 'pushed') return 300;
  if (o.outcome === 'dropped') {
    const ladder = o.reconnectBackoffMs.length > 0 ? o.reconnectBackoffMs : [2000];
    const step = Math.min(Math.max((o.dropStreak ?? 1) - 1, 0), ladder.length - 1);
    const base = ladder[step] ?? 2000;
    const rand = o.random ?? Math.random;
    return Math.round(base * (0.85 + rand() * 0.3));
  }
  return o.pollIntervalMs;
}

/**
 * 单进程常驻版：收件 → 白名单纳入 → 处理，跑同一个循环。
 *
 * `imap.idle = true` 时走长连接：循环不再只是干等 5 分钟，而是挂在 `exists` 上，
 * 邮件一到就立刻跑一轮；兜底轮询**仍然保留**（也就是最多等 pollIntervalMs），
 * 因为 IDLE 会静默断、也可能被服务器拒绝，不能把「收件」全押在推送这一条路上。
 *
 * `keepAlive` 决定这个循环定时器要不要 `unref()`：
 * CLI 常驻必须是 true，否则首轮跑完事件循环就空了，进程安静退出（而屏幕上还写着「已启动」）；
 * 测试里给 false，免得把测试进程吊着不退出。
 */
export function startAutoPipeline(
  handle: DbHandle,
  onTick: (payload: { at: string; kind: string; detail: string }) => void = () => {},
  options: { keepAlive?: boolean } = {},
): () => void {
  const { config } = handle;
  const idleWanted = config.ingest.imap.idle && config.ingest.mode !== 'folder' && Boolean(config.ingest.imap.user);
  const session = idleWanted
    ? new ImapSession(config, (m) => console.log(`  IMAP：${m}`))
    : undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  /** 连续掉线次数：连着掉说明不是偶发抖动，退避要拉长 */
  let dropStreak = 0;

  const schedule = (delay: number) => {
    if (stopped) return;
    timer = setTimeout(() => void cycle(), delay);
    if (!options.keepAlive) timer.unref?.();
  };

  const cycle = async () => {
    let outcome: ImapIdleOutcome | 'off' = 'off';
    try {
      await runAutoCycle(handle, { session });
      if (session) outcome = await session.waitForPush(config.ingest.pollIntervalMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onTick({ at: new Date().toISOString(), kind: 'cycle-error', detail: msg });
      // 光甩一句 ECONNRESET 没用，得说清「这是限流，别再去撞」还是「密码错了，去改」
      const hint = explainImapError(err);
      console.log(`  （本轮出错：${msg}${hint ? `\n      ↳ ${hint}` : ''}）`);
      // 邮箱侧出错（连不上、被拒）不能按普通间隔慢慢等，走退避重连
      outcome = session ? 'dropped' : 'off';
    }
    // 掉线计数与提示统一在这里：一次掉线是意外，连着掉就该把间隔拉开（见 nextCycleDelay）
    const delay = nextCycleDelay({
      idle: Boolean(session),
      outcome,
      pollIntervalMs: config.ingest.pollIntervalMs,
      reconnectBackoffMs: config.ingest.imap.reconnectBackoffMs,
      // 按「这一次掉线」选档位，所以先把这次算进去
      dropStreak: outcome === 'dropped' ? dropStreak + 1 : dropStreak,
    });
    if (outcome === 'dropped') {
      dropStreak += 1;
      // 把下一次的时间点打出来：否则屏幕上只有一条条刷过去的报错，看不出退避其实生效了
      console.log(`  （IMAP 连接掉了，第 ${dropStreak} 次，${Math.round(delay / 1000)} 秒后重连）`);
    } else {
      dropStreak = 0;
    }
    schedule(delay);
  };

  schedule(0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (session) void session.disconnect();
  };
}

/** 轮询 + 兜底扫描的双通道调度器；真要秒级再把 imap idle 打开 */
export function startWatchers(
  handle: DbHandle,
  onTick: (payload: { at: string; kind: string; detail: string }) => void = () => {},
  options: { keepAlive?: boolean } = {},
): () => void {
  const { config } = handle;
  const ingestTimer = setInterval(async () => {
    try {
      const r = await ingestOnce(handle);
      onTick({ at: new Date().toISOString(), kind: 'ingest', detail: JSON.stringify(r) });
    } catch (err) {
      onTick({ at: new Date().toISOString(), kind: 'ingest-error', detail: String(err) });
    }
  }, config.ingest.pollIntervalMs);

  const workTimer = setInterval(async () => {
    try {
      const s = await processOnce(handle);
      if (s.processed > 0) onTick({ at: new Date().toISOString(), kind: 'process', detail: JSON.stringify(s) });
    } catch (err) {
      onTick({ at: new Date().toISOString(), kind: 'process-error', detail: String(err) });
    }
  }, 5000);

  // 同上：CLI 常驻要 keepAlive，否则「后台扫描已启动」之后进程立刻退出，看着像在跑其实已经死了
  if (!options.keepAlive) {
    ingestTimer.unref?.();
    workTimer.unref?.();
  }
  return () => {
    clearInterval(ingestTimer);
    clearInterval(workTimer);
  };
}
