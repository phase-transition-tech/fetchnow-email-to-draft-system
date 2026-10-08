import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { simpleParser } from 'mailparser';
import type { Config } from './config.js';
import { ImapSession, explainImapError } from './imap.js';
import { createInvoice, insertMessage, logFiltered, recordEvent, type DbHandle } from './db.js';
import type { RawAttachment, RawMessage } from './types.js';

export interface IngestResult {
  scanned: number;
  inserted: number;
  filtered: number;
  duplicates: number;
}

interface ParsedEnvelope {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string;
  attachments: { filename: string; contentType: string; buffer: Buffer }[];
}

export const sha256Buffer = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

const safeFilename = (name: string): string => path.basename(name).replace(/[^\w.\-]+/g, '_').slice(0, 80);
export const NOT_INVOICE_FLAG = 'MISSING_REQUIRED_FIELD';

/** 「名字 <a@b.com>」这种 header 里的写法，取到 a@b.com；取不到就返回空串 */
export function senderAddr(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return ((m?.[1] ?? from) || '').trim().toLowerCase();
}

/** 取域名部分。没有 @ 的畸形地址返回空串，交给调用方当「认不出来」处理 */
export function senderDomain(from: string): string {
  return senderAddr(from).split('@').pop() ?? '';
}

/**
 * 域名白名单比对：配 "vendor.com" 能同时放行 boss@vendor.com / ap@vendor.com；
 * 配 ".vendor.com" 或 "sub.vendor.com" 走子域精确匹配，不会顺手把别人的 vendor.com.attacker.com 放进来。
 */
export function senderAllowed(from: string, allowed: string[]): boolean {
  const addr = senderAddr(from);
  if (!addr) return false; // 认不出发件人就不放行
  const domain = senderDomain(from);
  return allowed.some((d) => {
    const key = d.trim().toLowerCase();
    if (!key) return false;
    if (key.startsWith('.')) return domain === key.slice(1) || domain.endsWith(key);
    return domain === key;
  });
}

async function parseEnvelope(source: Buffer): Promise<ParsedEnvelope> {
  const mail = await simpleParser(source);
  const headers = mail.headers as Map<string, string[]>;
  const first = (name: string): string => {
    const v = headers.get(name);
    return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
  };
  const attachments = (mail.attachments ?? [])
    .filter((a) => a.content && Buffer.isBuffer(a.content))
    .map((a) => ({
      filename: a.filename ?? 'attachment.bin',
      contentType: a.contentType ?? 'application/octet-stream',
      buffer: a.content as Buffer,
    }));
  return {
    messageId: first('message-id').replace(/^<|>$/g, '').trim(),
    from: mail.from?.text ?? '',
    subject: mail.subject ?? '',
    receivedAt: mail.date ? mail.date.toISOString() : new Date().toISOString(),
    attachments,
  };
}

/** 同 Hash 的附件只落盘一次：重发邮件拿到完全相同的字节，直接命中已有文件 */
function saveAttachment(cfg: Config, filename: string, buffer: Buffer): RawAttachment {
  const dir = cfg.storage.attachmentsDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const sha = sha256Buffer(buffer);
  const target = path.join(dir, `${sha.slice(0, 16)}-${safeFilename(filename)}`);
  if (!existsSync(target)) writeFileSync(target, buffer);
  return {
    filename: safeFilename(filename),
    contentType: 'application/pdf',
    size: buffer.length,
    sha256: sha,
    path: target,
  };
}

async function handleEnvelope(
  handle: DbHandle,
  env: ParsedEnvelope,
  source: string,
  result: IngestResult,
): Promise<void> {
  const { db, config } = handle;
  if (!env.messageId) return;

  const outcome = insertMessage(db, {
    messageId: env.messageId,
    from: env.from,
    subject: env.subject,
    receivedAt: env.receivedAt,
    source,
  });
  // scanned 由调用方按「扫了多少封」统计，这里只区分 duplicates / filtered / inserted，避免重复计数
  if (outcome === 'exists') {
    result.duplicates += 1;
    return;
  }

  const attachments: RawAttachment[] = [];
  for (const att of env.attachments) {
    if (!config.filters.allowedAttachmentTypes.includes(att.contentType)) {
      logFiltered(db, env, `附件类型被拒绝：${att.contentType}`);
      result.filtered += 1;
      continue;
    }
    if (att.buffer.length > config.filters.maxAttachmentBytes) {
      logFiltered(db, env, `附件超过体积上限：${att.buffer.length}B`);
      result.filtered += 1;
      continue;
    }
    attachments.push(saveAttachment(config, att.filename, att.buffer));
  }
  if (attachments.length === 0) {
    logFiltered(db, env, '没有可用的发票附件');
    result.filtered += 1;
    return;
  }

  // 发件人白名单：不在列表里就收件箱照收，但不进观察池。
  // 空数组 = 不限制（什么都进池子等人筛），不是「什么都不会进」。
  // 注意这里是按**域名**比（配置项就叫 allowedSenderDomains，写的是公司域）：
  // 配 "vendor.com" 就该把 boss@vendor.com 和 ap@vendor.com 一起放行，别去逐地址比。
  const allowed = config.filters.allowedSenderDomains;
  const addr = senderAddr(env.from);
  if (allowed.length > 0 && !senderAllowed(addr, allowed)) {
    logFiltered(db, env, `发件人不在白名单：${addr || '(无发件人)'}`);
    recordEvent(db, null, 'warn', '被发件人白名单挡下', `from=${env.from}`);
    result.filtered += 1;
    return;
  }

  // 一个 PDF = 一条发票任务。sha256 唯一约束保证「重发」命中 duplicate，而不是悄悄建第二单
  for (const att of attachments) {
    const res = createInvoice(db, {
      sha256: att.sha256,
      messageId: env.messageId,
      fromAddr: env.from,
      filename: att.filename,
      rawPath: att.path,
      status: 'observed',
    });
    if (res === 'duplicate') {
      recordEvent(db, null, 'warn', '重复附件：已存在相同 PDF', `sha256=${att.sha256.slice(0, 12)}`);
      result.duplicates += 1;
    } else {
      recordEvent(db, null, 'info', '新邮件进入观察池', `来源=${source} 附件=${att.filename}`);
      result.inserted += 1;
    }
  }
}

/** 本地目录源：开发与验收用，不依赖邮箱服务 */
export async function ingestFolder(handle: DbHandle): Promise<IngestResult> {
  const dir = path.resolve(process.cwd(), handle.config.ingest.folder.path);
  const result: IngestResult = { scanned: 0, inserted: 0, filtered: 0, duplicates: 0 };
  if (!existsSync(dir)) return result;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.eml'))
    .sort();
  result.scanned = files.length;
  for (const file of files) {
    const env = await parseEnvelope(readFileSync(path.join(dir, file)));
    await handleEnvelope(handle, env, 'folder', result);
  }
  return result;
}

/**
 * 真实邮箱收件：协议细节在 ./imap.ts，这里只管「取出来的邮件怎么进库」。
 *
 * `session` 由调用方给的时候（IDLE 常驻模式），扫完**不关连接**——连接要留着给 auto-IDLE 用；
 * 一次性调用（`scan`、测试）不传，函数自己建一个并在结束时关掉。
 */
export async function ingestImap(handle: DbHandle, session?: ImapSession): Promise<IngestResult> {
  const im = handle.config.ingest.imap;
  if (!im.user || !im.host) throw new Error('imap.host / imap.user 未配置，拒绝连邮箱');
  const result: IngestResult = { scanned: 0, inserted: 0, filtered: 0, duplicates: 0 };

  const own = !session;
  const session_ = session ?? new ImapSession(handle.config, (msg) => recordEvent(handle.db, null, 'info', `IMAP：${msg}`));
  try {
    return await scanWithSession(handle, session_, result);
  } finally {
    if (own) await session_.disconnect();
  }
}

async function scanWithSession(
  handle: DbHandle,
  session: ImapSession,
  result: IngestResult,
): Promise<IngestResult> {
  await session.ensureConnected();
  const scan = await session.scan();
  for (const msg of scan.messages) {
    const env = await parseEnvelope(msg.source);
    if (!env.messageId) continue;
    result.scanned += 1;
    await handleEnvelope(handle, env, 'imap', result);
  }
  if (scan.validityChanged) {
    recordEvent(handle.db, null, 'warn', '邮箱 uidValidity 变化，UID 水位已作废并全量回溯');
  }
  return result;
}

export function runIngest(handle: DbHandle, options: { session?: ImapSession } = {}): Promise<IngestResult> {
  const mode = handle.config.ingest.mode;
  const session = options.session;
  if (mode === 'imap') return ingestImap(handle, session);
  if (mode === 'both') {
    const im = handle.config.ingest.imap;
    // both 是「真邮箱 + 目录双跑」：邮箱没配好就别让整条 scan 挂掉，目录那路照跑。
    // 纯 imap 模式仍然硬抛（见 ingestImap），宁可失败也不默默收不到票
    if (!im.user || !im.host) {
      recordEvent(handle.db, null, 'warn', 'ingest.mode=both 但邮箱未配置，本轮跳过邮箱只扫目录', `user=${im.user || '(空)'} host=${im.host || '(空)'}`);
      return ingestFolder(handle);
    }
    // 邮箱配好了但连不上（网络挡 993、密码被拒、TLS 断在握手）也不能掀桌：
    // both 的意义就是一路坏掉另一路还能跑。同理把错误降级成事件流里的一条 warn。
    return ingestImap(handle, session)
      .then((imapRes) =>
        ingestFolder(handle).then((f) => ({
          scanned: imapRes.scanned + f.scanned,
          inserted: imapRes.inserted + f.inserted,
          filtered: imapRes.filtered + f.filtered,
          duplicates: imapRes.duplicates + f.duplicates,
        })),
      )
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        recordEvent(handle.db, null, 'warn', 'ingest.mode=both 但邮箱连不上，本轮只扫目录', msg);
        const hint = explainImapError(err);
        console.log(`  （邮箱连接失败，本轮只扫目录：${msg}${hint ? `\n      ↳ ${hint}` : ''}）`);
        return ingestFolder(handle);
      });
  }
  return ingestFolder(handle);
}
