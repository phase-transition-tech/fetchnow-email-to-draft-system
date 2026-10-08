import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import type { InvoiceStatus, RawMessage, ReviewFlag } from './types.js';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  message_id   TEXT PRIMARY KEY,
  from_addr    TEXT,
  subject      TEXT,
  received_at  TEXT,
  source       TEXT,
  created_at   TEXT
);

CREATE TABLE IF NOT EXISTS filtered (
  message_id TEXT PRIMARY KEY,
  from_addr  TEXT,
  subject    TEXT,
  reason     TEXT,
  at         TEXT
);

CREATE TABLE IF NOT EXISTS invoices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sha256        TEXT NOT NULL UNIQUE,
  message_id    TEXT NOT NULL,
  -- 发件人（原始 text，含显示名）：自动纳入靠它判域名，没有这一列就只能永远人工点
  from_addr     TEXT,
  filename      TEXT,
  raw_path      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'observed',
  vendor        TEXT,
  invoice_no    TEXT,
  issue_date    TEXT,
  due_date      TEXT,
  currency      TEXT,
  subtotal      REAL,
  tax           REAL,
  total         REAL,
  tax_type      TEXT,
  line_items    TEXT,
  extracted     TEXT,
  flags         TEXT,
  confidence    TEXT,
  provider      TEXT,
  provider_ref  TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  due_at        TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER,
  level      TEXT,
  message    TEXT,
  detail     TEXT,
  at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_events_invoice ON events(invoice_id, id);
`;

export interface DbHandle {
  config: Config;
  db: DatabaseSync;
}

/**
 * 老库（git 里已存在的 fetchnow.sqlite）建表时没有 from_addr 列，
 * CREATE TABLE IF NOT EXISTS 不会给它补。这里按 pragma 查一次再 ALTER，
 * 否则老库上自动纳入永远判不出来——而且错误只表现为「域名填了却不生效」，极难发现。
 */
function migrateFromAddr(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(invoices)').all() as { name: string }[];
  if (cols.some((c) => c.name === 'from_addr')) return;
  db.exec('ALTER TABLE invoices ADD COLUMN from_addr TEXT;');
}

/**
 * node:sqlite 是实验特性，偶尔会在「目录刚创建 / 上一进程还没把手上的 journal 收干净」时
 * 抛 SQLITE_IOERR（表现为一句没头没尾的 disk I/O error）。
 * 这里补上目录创建 + 几次快速重试，比让整条命令以一句看不懂的错退出去强。
 */
export function open(config: Config): DbHandle {
  const dir = config.storage.dir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fetchnow.sqlite');
  let db: DatabaseSync | null = null;
  let lastErr: unknown;
  for (let i = 0; i < 5 && !db; i += 1) {
    try {
      const candidate = new DatabaseSync(file);
      candidate.exec('PRAGMA journal_mode = WAL;');
      candidate.exec('PRAGMA foreign_keys = ON;');
      candidate.exec(SCHEMA);
      migrateFromAddr(candidate);
      db = candidate;
    } catch (err) {
      lastErr = err;
      try {
        db?.close();
      } catch {
        /* 上一次打开的库没关成，忽略 */
      }
      db = null;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1));
    }
  }
  if (!db) throw lastErr instanceof Error ? lastErr : new Error(`打开数据库失败：${String(lastErr)}`);
  return { config, db };
}

const now = () => new Date().toISOString();

export function insertMessage(db: DatabaseSync, msg: RawMessage): 'inserted' | 'exists' {
  const row = db
    .prepare('SELECT 1 AS x FROM messages WHERE message_id = ?')
    .get(msg.messageId) as { x: number } | undefined;
  if (row) return 'exists';
  db.prepare(
    `INSERT INTO messages (message_id, from_addr, subject, received_at, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(msg.messageId, msg.from, msg.subject, msg.receivedAt, msg.source, now());
  return 'inserted';
}

export function logFiltered(
  db: DatabaseSync,
  msg: { messageId: string; from: string; subject: string },
  reason: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO filtered (message_id, from_addr, subject, reason, at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(msg.messageId, msg.from, msg.subject, reason, now());
}

/** sha256 是唯一约束：同一份 PDF 无论从哪封邮件进来，都只会产生一条发票任务 */
export function createInvoice(
  db: DatabaseSync,
  invoice: {
    sha256: string;
    messageId: string;
    filename: string;
    rawPath: string;
    status?: InvoiceStatus;
    flags?: ReviewFlag[];
    dueAt?: string | null;
    fromAddr?: string | null;
  },
): 'created' | 'duplicate' {
  const existed = db.prepare('SELECT id FROM invoices WHERE sha256 = ?').get(invoice.sha256);
  if (existed) return 'duplicate';
  db.prepare(
    `INSERT INTO invoices
       (sha256, message_id, from_addr, filename, raw_path, status, flags, due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    invoice.sha256,
    invoice.messageId,
    invoice.fromAddr ?? null,
    invoice.filename,
    invoice.rawPath,
    invoice.status ?? 'observed',
    JSON.stringify(invoice.flags ?? []),
    invoice.dueAt ?? null,
    now(),
    now(),
  );
  return 'created';
}

export function getInvoice(db: DatabaseSync, id: number): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
}

export function listInvoices(
  db: DatabaseSync,
  status?: InvoiceStatus | InvoiceStatus[],
): Record<string, unknown>[] {
  if (!status) return db.prepare('SELECT * FROM invoices ORDER BY id').all() as Record<string, unknown>[];
  const list = Array.isArray(status) ? status : [status];
  const ph = list.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM invoices WHERE status IN (${ph}) ORDER BY id`)
    .all(...list) as Record<string, unknown>[];
}

export function dueInvoices(db: DatabaseSync, limit = 10): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT * FROM invoices
       WHERE status IN ('admitted','retry') AND (due_at IS NULL OR due_at <= ?)
       ORDER BY id LIMIT ?`,
    )
    .all(now(), limit) as Record<string, unknown>[];
}

export function updateInvoice(
  db: DatabaseSync,
  id: number,
  patch: Record<string, string | number | null>,
): void {
  const keys = Object.keys(patch).filter((k) => k !== 'id');
  const sql = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE invoices SET ${sql}, updated_at = ? WHERE id = ?`).run(
    // null 就是 SQL NULL，千万别 String() 成字面量 "null"：
    // 那是个 truthy 字符串，会把「字段缺失」的判断全带偏（!row.total 不再成立）
    ...keys.map((k) => patch[k] ?? null),
    now(),
    id,
  );
}

export function recordEvent(
  db: DatabaseSync,
  invoiceId: number | null,
  level: 'info' | 'warn' | 'error',
  message: string,
  detail: string = '',
): void {
  db.prepare('INSERT INTO events (invoice_id, level, message, detail, at) VALUES (?, ?, ?, ?, ?)').run(
    invoiceId,
    level,
    message,
    detail,
    now(),
  );
}

export function eventsFor(db: DatabaseSync, invoiceId: number): Record<string, unknown>[] {
  return db.prepare('SELECT * FROM events WHERE invoice_id = ? ORDER BY id').all(invoiceId) as
    Record<string, unknown>[];
}
