import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePaths, loadConfig } from './config.js';
import type { Config } from './config.js';
import { listInvoices, getInvoice, eventsFor, open, recordEvent, updateInvoice } from './db.js';
import type { DbHandle } from './db.js';
import {
  admitInvoice,
  autoAdmitTrusted,
  ingestOnce,
  processOnce,
  retryInvoice,
  runAutoCycle,
  startAutoPipeline,
  startWatchers,
} from './pipeline.js';
import { ImapSession, explainImapError, loadState } from './imap.js';
import { exchangeCode, authorizeUrl, refreshToken } from './xero/oauth.js';
import { XeroApiAdapter } from './xero.js';

type Handler = (args: string[]) => Promise<void>;

const cmds: Record<string, Handler> = {
  /**
   * demo 走完整闭环，但保留人工确认门：收件 → 观察池 → 模拟人工「全部纳入」→ 串行处理。
   * 这样演示时能看清「机器不会自己把邮件变成账单」，中间那一步是有人点的。
   */
  async demo() {
    await cmdScan([]);
    // 全程复用同一个 handle：每条票都 `repo()` 会新开一条 sqlite 连接，
    // WAL 下多连接各持快照，读到的队列可能互相看不见（表现为「明明做了却报 0 条」）
    const handle = repo();
    const { db } = handle;
    const observed = listInvoices(db, 'observed');
    console.log(`观察池 ${observed.length} 条，状态 observed（对应「待开票输入」面板，等人工确认）`);

    let admitted = 0;
    for (const row of observed) if (admitInvoice(handle, Number(row.id)) === 'ok') admitted += 1;
    console.log(`人工确认纳入：${admitted} 条`);

    for (let i = 0; i < 20; i += 1) {
      const r = await processOnce(handle);
      if (r.processed === 0) break;
      console.log(
        `  处理 ${r.processed} 条：建草稿 ${r.created}，转人工 ${r.review}，重试 ${r.retried}，死信 ${r.dead}，跳过 ${r.skipped}`,
      );
    }
  },

  async scan(args) {
    await cmdScan(args);
  },

  async list(args) {
    const idx = args.indexOf('--status');
    const status = idx >= 0 ? args[idx + 1] : undefined;
    const { db } = repo();
    const rows = listInvoices(db, status as never);
    if (rows.length === 0) {
      console.log('（没有任务）');
      return;
    }
    for (const r of rows) {
      console.log(
        `#${String(r.id).padEnd(4)} ${String(r.status).padEnd(10)} ${String(r.vendor ?? '-').slice(0, 22).padEnd(24)} ` +
          `发票号 ${String(r.invoice_no ?? '-').padEnd(12)} 总额 ${String(r.total ?? '-').padEnd(10)} ` +
          `草稿 ${String(r.provider_ref ?? '-')}`,
      );
    }
  },

  async show(args) {
    const id = Number(args[0]);
    if (!id) {
      console.log('用法：show <任务id>');
      return;
    }
    const { db } = repo();
    const row = getInvoice(db, id);
    if (!row) {
      console.log('任务不存在');
      return;
    }
    console.log(JSON.stringify(row, null, 2));
    console.log('--- 事件流 ---');
    for (const e of eventsFor(db, id)) {
      console.log(`${String(e.at)} [${String(e.level)}] ${String(e.message)} ${String(e.detail ?? '')}`);
    }
  },

  async admit(args) {
    // 同上：一次命令只开一条连接，别在循环里反复 repo()
    const handle = repo();
    const { db } = handle;
    if (args.includes('--all')) {
      let n = 0;
      for (const r of listInvoices(db, 'observed')) {
        if (admitInvoice(handle, Number(r.id)) === 'ok') n += 1;
      }
      console.log(`已全部纳入：${n} 条`);
      return;
    }
    const id = Number(args[0]);
    if (!id) {
      console.log('用法：admit <任务id| --all>');
      return;
    }
    console.log(admitInvoice(handle, id) === 'ok' ? '已纳入' : '状态不是 observed');
  },

  /**
   * 一条命令跑完整自动闭环：收件 → 白名单自动纳入 → 处理到草稿。
   * 默认常驻（--once 只跑一轮），因为「邮件到了自动出草稿」这才是真正的用法。
   */
  async watch(args) {
    const list = (resolvePaths(loadConfig()).review.autoAdmitDomains ?? []);
    if (list.length > 0) {
      console.log(`自动纳入白名单：${list.join(', ')}（命中即自动处理，其余仍等人确认）`);
    } else {
      console.log('自动纳入白名单是空的：收进来的票会停在「待开票输入」等人点 admit。');
      console.log('想让它全自动，把发件域名加到 config/default.json 的 review.autoAdmitDomains（或 FN_AUTO_ADMIT_DOMAINS）。');
    }
    console.log('');
    const handle = repo();
    if (args.includes('--once')) {
      await runAutoCycle(handle);
      return;
    }
    const im = handle.config.ingest.imap;
    const idle = im.idle && handle.config.ingest.mode !== 'folder' && Boolean(im.user);
    console.log(
      idle
        ? `收件：IMAP 长连接 + auto-IDLE（imapflow 自动进出 IDLE，${String(im.maxIdleTimeMs / 60000)} 分钟重进一次），兜底轮询 ${String(handle.config.ingest.pollIntervalMs / 1000)} 秒`
        : `收件：轮询，每 ${String(handle.config.ingest.pollIntervalMs / 1000)} 秒一轮（imap.idle 关着，或收件源是本地目录）`,
    );
    // keepAlive 必须给：不给的话这个定时器不撑事件循环，首轮跑完进程就安静退出了
    const stop = startAutoPipeline(handle, (t) => console.log(`[${t.kind}] ${t.detail}`), { keepAlive: true });
    // 先立刻跑一轮：邮件是「刚才发的」，等 5 分钟才知道太钝
    console.log('自动闭环已启动，Ctrl+C 退出\n');
    process.on('SIGINT', () => {
      stop();
      process.exit(0);
    });
  },

  async process(args) {
    await cmdProcess(args);
  },

  async retry(args) {
    const id = Number(args[0]);
    if (!id) {
      console.log('用法：retry <任务id>');
      return;
    }
    retryInvoice(repo(), id);
    console.log(`任务 #${id} 已重新入队（重推仍走同一幂等键，不会重复建单）`);
  },

  /**
   * 把一条已经跑完的票倒回起点，再走一遍链路。
   *
   * 为什么需要它：同一张发票第二次收会被两层去重挡下（messages 按 messageId、invoices 按 sha256），
   * 所以「再测一遍」不能靠重发邮件 —— 只能亲手把状态倒回去。默认只倒「纳入 → 建草稿」这一步；
   * 加 `--from-mail` 会把邮件记录一起清掉，让 scan 真的重收一遍（验完整链路）。
   */
  async retest(args) {
    const handle = repo();
    const { db, config } = handle;
    const fromMail = args.includes('--from-mail');
    // 只认纯数字的位置参数，别把 '--from-mail' Number() 成 NaN
    const explicit = args.map((a) => Number(a)).find((n) => Number.isInteger(n) && n > 0);
    const picked = db
      .prepare("SELECT id FROM invoices WHERE status = 'created' ORDER BY id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    const id = explicit ?? Number(picked?.id ?? 0);
    if (!id) {
      console.log('用法：retest [<任务id>] [--from-mail]（不给 id 时默认挑最后一条已建草稿的票）');
      return;
    }
    const row = getInvoice(db, id);
    if (!row) {
      console.log(`任务 #${id} 不存在`);
      return;
    }
    // 旧草稿文件两条路径都要删：不删的话每测一次就多一个孤儿 json
    const oldRef = row.provider_ref ? String(row.provider_ref) : '';
    if (oldRef) {
      const oldFile = join(config.storage.draftsDir, `${oldRef}.json`);
      if (existsSync(oldFile)) unlinkSync(oldFile);
    }

    if (!fromMail) {
      updateInvoice(db, id, {
        status: 'observed',
        provider_ref: null,
        attempt_count: 0,
        last_error: null,
      });
      recordEvent(db, id, 'info', '重测：已复位回观察池', oldRef ? `原草稿 ${oldRef} 已删除` : '');
      console.log(`已复位 #${id} → observed${oldRef ? `（旧草稿 ${oldRef} 已删）` : ''}`);
      await finishRetest(handle, id);
      return;
    }

    // 完整路径：把「收了哪封邮件」也倒回去。messages 那行必须删 ——
    // 否则 scan 在 messageId 这一层就判重复，根本进不到入库那步，
    // 会看到「扫描 N 封、新入库 0」这种让人以为代码坏了的输出。
    const mid = row.message_id ? String(row.message_id) : '';
    const sha = row.sha256 ? String(row.sha256) : '';
    db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
    if (mid) db.prepare('DELETE FROM messages WHERE message_id = ?').run(mid);
    console.log(`已清掉 #${id} 及其邮件记录（message_id=${mid || '(无)'}）${oldRef ? `，旧草稿 ${oldRef} 已删` : ''}`);
    if (config.ingest.mode !== 'folder') {
      console.log(
        `注意：当前 ingest.mode = "${config.ingest.mode}"，收件会去连一次邮箱；限流期间建议用 FN_INGEST_MODE=folder 只扫本地目录`,
      );
    }
    const ing = await ingestOnce(handle);
    console.log(`收件：扫描 ${ing.scanned} 封，新入库 ${ing.inserted}，重复 ${ing.duplicates}，被过滤 ${ing.filtered}`);
    const fresh = db
      .prepare('SELECT id FROM invoices WHERE sha256 = ? ORDER BY id DESC LIMIT 1')
      .get(sha) as { id: number } | undefined;
    if (!fresh) {
      console.log('这封邮件没进来：检查收件源里还有没有它（fixtures/inbox）或换个附件再试');
      return;
    }
    console.log(`重新入库为 #${fresh.id}`);
    await finishRetest(handle, fresh.id);
  },

  /**
   * 接真 Xero 的三步前置验证。顺序不能跳：
   * token-url（拿授权链接）→ auth（落盘 token）→ check（确认 scope/tenant 通）。
   * 第三步过不了之前，别把 provider 从 mock 改 xero，否则每次建单都在撞 401。
   */
  async xero(args) {
    const sub = args[0] ?? '';
    const cfg = resolvePaths(loadConfig());
    if (cfg.xero.provider !== 'xero') {
      console.log(`当前 xero.provider = "mock"：demo/scan/process 只往 ${cfg.storage.draftsDir} 写本地草稿，不碰 Xero。`);
      console.log('下面这条是通往真环境的门，不是现在的必经步骤；想直接看本地效果就别跑，去做 `npm run demo`。\n');
    }
    if (sub === 'token-url') {
      if (!cfg.xero.clientId || !cfg.xero.clientSecret) {
        console.log('还没配 Xero 应用凭据：填 config 的 xero.clientId/clientSecret，或 export XERO_CLIENT_ID / XERO_CLIENT_SECRET。');
        console.log('（这一步在 mock 模式下完全不需要）');
        return;
      }
      console.log(authorizeUrl(cfg));
      console.log('浏览器打开上面这个链接 → 同意后回调地址会带 ?code=... → 再跑 `xero auth --code=...`');
      console.log(`redirect_uri 必须和 Xero 后台登记的完全一致（当前 ${cfg.xero.redirectUri}）`);
      return;
    }
    if (sub === 'auth') {
      const idx = args.indexOf('--code');
      const code = (idx >= 0 ? args[idx + 1] : process.env.XERO_AUTH_CODE) ?? '';
      if (!code) {
        console.log('用法：xero auth --code=回调地址里拿到的 code（或设 XERO_AUTH_CODE，需先配好 clientId/clientSecret）');
        return;
      }
      const token = await exchangeCode(cfg, code);
      console.log(`token 已落盘到 ${cfg.xero.tokenPath}，有效期到 ${token.expiresAt}`);
      console.log('接下来：在 Xero → 设置 → 已连接的 App 里找到本应用，复制 Tenant Id 后 `export XERO_TENANT_ID=...`，再跑 `xero check`');
      return;
    }
    if (sub === 'refresh') {
      const token = await refreshToken(cfg);
      console.log(`已轮换：新的有效期到 ${token.expiresAt}`);
      return;
    }
    if (sub === 'check') {
      try {
        const info = await new XeroApiAdapter(cfg).probe();
        console.log(`Xero 连通：组织「${info.orgName}」（${info.status}）`);
        console.log(`下一步把 config 里 xero.provider 改成 "xero"，或 export FN_XERO_PROVIDER=xero`);
      } catch (err) {
        // 未授权不该甩一栈，说明白缺哪一步
        console.log(err instanceof Error ? err.message : String(err));
        console.log('（这一步在 mock 模式下完全不需要）');
      }
      return;
    }
    console.log('用法：xero token-url | auth --code=... | refresh | check');
  },

  /** 先探活再入库：连不上邮箱时，不该让一堆报错混进任务队列 */
  async imap(args) {
    const sub = args[0] ?? '';
    const cfg = resolvePaths(loadConfig());
    if (sub === 'state') {
      const state = loadState(cfg);
      console.log(state ? JSON.stringify(state, null, 2) : '（还没有水位记录，下次扫描会全量回溯）');
      return;
    }
    if (sub !== 'check') {
      console.log('用法：imap check | imap state');
      return;
    }
    // 先把「账号有没有被读到」摆到台面上：读不到就直说，别让人对着 TLS 报错猜半天
    const im = cfg.ingest.imap;
    if (!im.user || !im.host) {
      console.log(`账号读不到：user=${im.user || '(空)'} host=${im.host || '(空)'} port=${String(im.port)}`);
      console.log('  .env 现在会自动加载（项目根目录的 .env，键已存在则 shell 里的优先），不用再手写 --env-file=.env');
      console.log('  填完再跑；也可以临时 export FN_IMAP_USER / FN_IMAP_PASS\n');
      return;
    }
    console.log(`读到账号 ${im.user.slice(0, 3)}***@${im.user.split('@')[1] || '?'} @ ${im.host}:${String(im.port)}`);
    if (cfg.ingest.mode === 'folder') {
      console.log('（当前 ingest.mode = "folder"，收件走本地目录 fixtures/inbox，不连邮箱；探活只是提前验证连通性）\n');
    }
    const session = new ImapSession(cfg, (m) => console.log(`  ${m}`));
    try {
      const p = await session.probe();
      console.log(`连接 ${cfg.ingest.imap.host}:${cfg.ingest.imap.port} 成功`);
      console.log(`  邮箱里的邮件数 ${p.exists}，uidValidity=${String(p.uidValidity)}`);
      console.log(`  已选中的邮箱 ${String(p.selected)}，本次会回溯到 ${p.since}`);
      console.log(`  可用邮箱/标签 ${p.mailboxes.length} 个：${p.mailboxes.slice(0, 8).join(', ')}${p.mailboxes.length > 8 ? ' ...' : ''}`);
      console.log('探活通过。把 ingest.mode 改成 imap（或 both）后可直接 scan');
    } catch (err) {
      console.log(err instanceof Error ? err.message : String(err));
      // 「连不上」有四种完全不同的原因，方向对了才好修：限流要停手，密码错要去改 App Password
      const hint = explainImapError(err);
      if (hint) console.log(`  ↳ ${hint}`);
      console.log('（这一步在 folder 收件源下完全不需要）');
    } finally {
      await session.disconnect();
    }
  },

  async reconcile() {
    const { db, config } = repo();
    // 每日全量对账：把最近 N 天带附件的邮件再扫一遍，补齐漏网的，顺带复核被过滤器挡掉的
    const before = db.prepare('SELECT COUNT(*) AS c FROM invoices').get() as { c: number };
    // 复用同一个句柄：对账只是再扫一遍，绝不能让第二条连接写同一份 sqlite
    const r = await ingestOnce({ db, config });
    const after = db.prepare('SELECT COUNT(*) AS c FROM invoices').get() as { c: number };
    console.log(`扫描 ${r.scanned} 封，新入库 ${r.inserted}，重复 ${r.duplicates}，被过滤 ${r.filtered}`);
    console.log(`发票任务 ${before.c} -> ${after.c}`);
    console.log('被过滤器挡掉的邮件：');
    for (const f of db.prepare('SELECT * FROM filtered ORDER BY at DESC LIMIT 20').all() as Record<string, unknown>[]) {
      console.log(`  ${String(f.from_addr)} | ${String(f.subject)} | ${String(f.reason)}`);
    }
    void config;
  },
};

function repo() {
  return open(resolvePaths(loadConfig()));
}

/**
 * retest 的后半段：纳入 → 处理 → 把事件流和草稿内容打出来。
 * 两条重测路径（轻量复位 / 连收件一起重来）共用同一段，逻辑只能有一份。
 */
async function finishRetest(handle: DbHandle, id: number): Promise<void> {
  const { db, config } = handle;
  if (admitInvoice(handle, id) !== 'ok') {
    console.log('纳入失败：状态不是 observed');
    return;
  }
  console.log('人工确认纳入：1 条');
  for (let i = 0; i < 5; i += 1) {
    const r = await processOnce(handle);
    if (r.processed === 0) break;
    console.log(
      `  处理 ${r.processed} 条：建草稿 ${r.created}，转人工 ${r.review}，重试 ${r.retried}，死信 ${r.dead}，跳过 ${r.skipped}`,
    );
  }

  const after = getInvoice(db, id) ?? {};
  console.log(`\n最终：#${id} ${String(after.status)}  草稿 ${String(after.provider_ref ?? '-')}`);
  console.log('--- 事件流 ---');
  for (const e of eventsFor(db, id)) {
    console.log(`${String(e.at)} [${String(e.level)}] ${String(e.message)} ${String(e.detail ?? '')}`);
  }
  const ref = after.provider_ref ? String(after.provider_ref) : '';
  if (!ref) return;
  const file = join(config.storage.draftsDir, `${ref}.json`);
  if (existsSync(file)) {
    console.log(`--- 草稿内容（${file}）---`);
    console.log(readFileSync(file, 'utf8').trim());
  }
}

async function cmdScan(args: string[]) {
  const r = await ingestOnce(repo());
  console.log(`扫描 ${r.scanned} 封：新入库 ${r.inserted}，重复 ${r.duplicates}，被过滤 ${r.filtered}`);
  if (args.includes('--watch')) {
    const stop = startWatchers(repo(), () => {}, { keepAlive: true });
    console.log('后台扫描已启动，Ctrl+C 退出');
    process.on('SIGINT', () => {
      stop();
      process.exit(0);
    });
  }
}

async function cmdProcess(args: string[]) {
  const r = await processOnce(repo());
  console.log(
    `处理 ${r.processed} 条：建草稿 ${r.created}，转人工 ${r.review}，重试 ${r.retried}，死信 ${r.dead}，跳过 ${r.skipped}`,
  );
  if (args.includes('--watch')) {
    const stop = startWatchers(repo(), () => {}, { keepAlive: true });
    console.log('后台处理已启动，Ctrl+C 退出');
    process.on('SIGINT', () => {
      stop();
      process.exit(0);
    });
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  let handler = cmds[cmd ?? ''] as Handler | undefined;
  let rest = args;
  // 支持 `xero token-url` / `imap check` 这种两级命令
  if (!handler && cmd) {
    const [sub, ...subRest] = args;
    handler = cmds[sub ?? ''] as Handler | undefined;
    rest = subRest;
  }
  if (!handler) {
    console.log(
      '用法：watch [--once] | demo | scan [--watch] | list [--status] | show <id> | admit <id|--all> | process [--watch] | retry <id> | retest [<id>] | reconcile\n' +
        '      xero token-url | xero auth --code=... | xero refresh | xero check\n' +
        '      imap check | imap state',
    );
    return;
  }
  await handler(rest);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
