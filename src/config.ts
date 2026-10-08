import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * 自动加载项目根目录的 .env（不装 dotenv，纯手写）。
 *
 * 只补「进程里还没有」的键：shell 里 export 的、以及 `node --env-file=.env` 已经注入的都优先，
 * 所以这个函数的存在不会让 `export FN_XERO_PROVIDER=xero` 之类的临时覆盖失效。
 * 解析出错就当没有 .env，绝不能让配置读取把整个 CLI 带走。
 */
function loadDotenvIfPresent(): void {
  const file = path.resolve(process.cwd(), '.env');
  let raw: string;
  try {
    if (!existsSync(file)) return;
    raw = readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const body = s.startsWith('export ') ? s.slice('export '.length).trim() : s;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in process.env) continue;
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/#.*$/, '').trim(); // 非引号包裹时，# 之后算注释
    }
    process.env[key] = value;
  }
}
loadDotenvIfPresent();

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  authMethod: 'password' | 'oauth';
  mailbox: string;
  /**
   * true = `watch` 常驻时保留长连接，靠 imapflow 的 auto-IDLE 收推送，邮件一到就跑一轮；
   * 兜底轮询（pollIntervalMs）依旧保留。只有 `watch` 用得上——`scan` 是一次性命令，
   * 扫完就关连接，开了也不会更快。
   */
  idle: boolean;
  /** 每隔这么久自动 DONE 再重进 IDLE，绕开服务器约 29 分钟静默掐空闲连接 */
  maxIdleTimeMs: number;
  /** 冷启动/uidValidity 变化时回溯多少天 */
  backfillDays: number;
  /** 两次扫描间隔小于这个值时，只扫「上次扫描之后」，省掉大量重复 fetch */
  incrementalWindowMinutes: number;
  connectionTimeoutMs: number;
  /**
   * 重连退避阶梯，越掉越久，最后一档封顶。
   * 阶梯必须**长到分钟级**：连不上时如果一直按 30 秒捶一次，服务端的限流会被每次重试
   * 不断续期（Gmail 就是这样，表现是 TLS 握手直接 ECONNRESET），永远好不了。
   * 拉到 10 分钟档之后，「等它自己过期」才有机会发生。
   */
  reconnectBackoffMs: number[];
  /** UID 水位与 uidValidity 的落盘位置 */
  statePath: string;
}

export interface Config {
  storage: { dir: string; attachmentsDir: string; draftsDir: string };
  ingest: {
    mode: 'folder' | 'imap' | 'both';
    folder: { path: string };
    folderBackfillDays: number;
    pollIntervalMs: number;
    imap: ImapConfig;
  };
  filters: {
    allowedSenderDomains: string[];
    allowedAttachmentTypes: string[];
    maxAttachmentBytes: number;
    minTextConfidenceChars: number;
  };
  extract: { ocrEnabled: boolean; ocrProvider: string; defaultCurrency: string };
  validation: {
    amountTolerance: number;
    /** 允许的税率白名单。不只是 GST：中文数电发票走增值税（1/3/5/6/9/13%）也用它比对 */
    allowedTaxRates: number[];
    maxDaysToDueDate: number;
  };
  xero: {
    provider: 'mock' | 'xero';
    baseUrl: string;
    authUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scope: string;
    lineAmountTypes: 'Inclusive' | 'Exclusive';
    defaultTaxCode: string;
    defaultAccountCode: string;
    /** OAuth2 落盘位置；凭据优先读 XERO_CLIENT_ID/XERO_CLIENT_SECRET 环境变量 */
    tokenPath: string;
    /** 建单前先查一次同发票号，防「POST 超时以为失败、重试又建一单」 */
    checkExisting: boolean;
    /** 距过期多少秒就提前换 token */
    expirySkewSec: number;
  };
  worker: { concurrency: number; maxAttempts: number; backoffMs: number[] };
  review: {
    autoCreateWhen: 'no-flags';
    /**
     * 这些域名/完整地址的发件人，邮件进来直接「确认纳入」，不用人点。
     * 空数组 = 永远只等人工确认（默认）。别图省事把这堆设成 ["*"]：
     * 那等于让全网任何人都敢往这个收件箱发 PDF。
     */
    autoAdmitDomains: string[];
  };
}

const defaultPath = fileURLToPath(new URL('../config/default.json', import.meta.url));
const base = JSON.parse(readFileSync(defaultPath, 'utf8')) as Config;

const env = process.env as Record<string, string | undefined>;
const envPatch: Config = {
  ...base,
  storage: {
    dir: env.FN_DATA_DIR ?? base.storage.dir,
    attachmentsDir: env.FN_ATTACH_DIR ?? base.storage.attachmentsDir,
    draftsDir: env.FN_DRAFT_DIR ?? base.storage.draftsDir,
  },
  ingest: {
    ...base.ingest,
    // 本地重测/演示时不想去连邮箱（例如 Gmail 正在限流），用 FN_INGEST_MODE=folder 只扫本地目录：
    // 这样重跑一轮不会再去撞一次真实 IMAP，把惩罚续期
    mode: (env.FN_INGEST_MODE as Config['ingest']['mode']) ?? base.ingest.mode,
    imap: {
      ...base.ingest.imap,
      // 邮箱账号密码不该进仓库，用环境变量给。
      // host/port/secure 一般就是 imap.gmail.com:993 + SSL，默认配置已经是对的值，
      // 只有换邮箱服务商（Outlook 993/SSL、Zoho 993/SSL、自建 dovecot 143/STARTTLS）才需要覆盖
      user: (env.FN_IMAP_USER ?? base.ingest.imap.user).trim(),
      // Google 应用专用密码页面上显示成「xxxx xxxx xxxx xxxx」，而 IMAP 认证只认连续 16 位，
      // 带空格会被 Gmail 判成 Invalid credentials。这里统一剥掉空白，粘着带空格的密码也能连。
      pass: (env.FN_IMAP_PASS ?? base.ingest.imap.pass).replace(/\s+/g, ''),
      host: (env.FN_IMAP_HOST ?? base.ingest.imap.host).trim(),
      port: env.FN_IMAP_PORT ? Number(env.FN_IMAP_PORT.trim()) : base.ingest.imap.port,
      secure: env.FN_IMAP_SECURE ? env.FN_IMAP_SECURE === 'true' : base.ingest.imap.secure,
    },
  },
  // 一次「邮件进来直接变草稿」的联调里，最省事的做法是只加自己的发件域名，
  // 所以 FN_AUTO_ADMIT_DOMAINS 给一个逗号分隔的覆盖（留空则用 config 里的列表）
  review: {
    ...base.review,
    autoAdmitDomains: env.FN_AUTO_ADMIT_DOMAINS
      ? env.FN_AUTO_ADMIT_DOMAINS.split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean)
      : base.review.autoAdmitDomains,
  },
  xero: {
    ...base.xero,
    provider: (env.FN_XERO_PROVIDER as Config['xero']['provider']) ?? base.xero.provider,
    lineAmountTypes:
      (env.FN_LINE_AMOUNT_TYPES as Config['xero']['lineAmountTypes']) ?? base.xero.lineAmountTypes,
  },
};

/** 测试要能只覆盖一两个字段，所以 overrid 是深合并的 Partial，而不是整块 Config */
/** 标量/数组整体替换、对象逐层下钻——不要写 `T[K] extends Json`，
 *  object 字面量类型有隐式索引签名，会被误判成“可以直接整体替换”，测试里只给一个 dir 就报错 */
type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export function loadConfig(overrides: DeepPartial<Config> = {}): Config {
  return JSON.parse(JSON.stringify(merge(envPatch, overrides))) as Config;
}

function merge<T>(base: T, patch: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = merge(cur as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function resolvePaths(config: Config): Config {
  const copy = JSON.parse(JSON.stringify(config)) as Config;
  copy.storage.dir = path.resolve(process.cwd(), copy.storage.dir);
  copy.storage.attachmentsDir = path.resolve(copy.storage.dir, 'attachments');
  copy.storage.draftsDir = path.resolve(copy.storage.dir, 'xero-drafts');
  return copy;
}
