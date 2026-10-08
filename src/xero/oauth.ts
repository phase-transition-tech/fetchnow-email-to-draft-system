/**
 * Xero OAuth2 的凭据存取与 token 轮换。
 *
 * 三个容易踩的点都在这里处理掉了：
 * 1. Xero 的 token 端点用 Basic（client_id:client_secret），不是请求体里的 client_id/secret；
 * 2. 换 token 时**一定会**同时返回新的 refresh_token，必须整体覆盖落盘（轮换），只存新的 access 会让下一次 refresh 拿旧 refresh_token 失败；
 * 3. access_token 有有效期，快到期就先换，别等 401 再换——401 之后再换，请求已经白跑一次了。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Config } from '../config.js';

export interface XeroToken {
  accessToken: string;
  refreshToken: string;
  /** ISO 时间字符串，落盘可读；内存里一律用 Date 处理 */
  expiresAt: string;
  scope?: string;
  obtainedAt: string;
}

export class XeroAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'XeroAuthError';
  }
}

/** 客户端凭据优先环境变量，方便不把 secret 写进仓库 */
export function credentials(cfg: Config): { clientId: string; clientSecret: string } {
  const clientId = process.env.XERO_CLIENT_ID || cfg.xero.clientId;
  const clientSecret = process.env.XERO_CLIENT_SECRET || cfg.xero.clientSecret;
  if (!clientId || !clientSecret) {
    throw new XeroAuthError(
      '缺少 Xero 客户端凭据：设置 XERO_CLIENT_ID / XERO_CLIENT_SECRET，或填 config 里的 xero.clientId/clientSecret',
    );
  }
  return { clientId, clientSecret };
}

export function resolveTokenPath(cfg: Config): string {
  return path.resolve(process.cwd(), cfg.xero.tokenPath);
}

export function loadToken(cfg: Config): XeroToken | null {
  const file = resolveTokenPath(cfg);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!raw.accessToken || !raw.refreshToken || !raw.expiresAt) return null;
    return {
      accessToken: String(raw.accessToken),
      refreshToken: String(raw.refreshToken),
      expiresAt: String(raw.expiresAt),
      scope: raw.scope ? String(raw.scope) : undefined,
      obtainedAt: raw.obtainedAt ? String(raw.obtainedAt) : new Date().toISOString(),
    };
  } catch {
    // 落盘被写坏不该让整个收票流程挂掉：宁可重新授权，也不要拿坏 token 去撞 401
    return null;
  }
}

export function saveToken(cfg: Config, token: XeroToken): void {
  const file = resolveTokenPath(cfg);
  mkdirSync(path.dirname(file), { recursive: true });
  // token 文件是凭证，别让它落在 umask 给的 0644 上
  writeFileSync(file, `${JSON.stringify(token, null, 2)}\n`, 'utf8');
  chmodSync(file, 0o600);
}

export function clearToken(cfg: Config): void {
  const file = resolveTokenPath(cfg);
  if (existsSync(file)) {
    // 先清内容再删，避免删到一半留下一个半截文件
    writeFileSync(file, '', { flag: 'w' });
  }
}

/** 距过期不到 skewSec 就算过期（先换再请求，别等 401） */
export function expiredAt(token: XeroToken, skewSec: number): boolean {
  return Date.parse(token.expiresAt) - skewSec * 1000 <= Date.now();
}

/** 授权页地址：抄下来丢浏览器，回调拿到 ?code= */
export function authorizeUrl(cfg: Config, state = randomBytes(12).toString('hex')): string {
  const { clientId } = credentials(cfg);
  const url = new URL(cfg.xero.authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', cfg.xero.redirectUri);
  url.searchParams.set('scope', cfg.xero.scope);
  url.searchParams.set('state', state);
  return url.toString();
}

async function requestToken(cfg: Config, body: URLSearchParams): Promise<XeroToken> {
  const { clientId, clientSecret } = credentials(cfg);
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(cfg.xero.tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new XeroAuthError(`Xero token 端点失败：${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
  }
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!json.access_token) throw new XeroAuthError('Xero 没返回 access_token');
  const token: XeroToken = {
    accessToken: json.access_token,
    // 有些授权流不给 refresh_token，但我们的 scope 含 offline_access，正常都会有
    refreshToken: json.refresh_token ?? '',
    expiresAt: new Date(Date.now() + (json.expires_in ?? 1800) * 1000).toISOString(),
    scope: json.scope,
    obtainedAt: new Date().toISOString(),
  };
  saveToken(cfg, token);
  return token;
}

/** 授权回调的 code 换 token（一次性） */
export async function exchangeCode(cfg: Config, code: string, redirectUri?: string): Promise<XeroToken> {
  return requestToken(
    cfg,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri ?? cfg.xero.redirectUri,
    }),
  );
}

/** 轮换：Xero 一定会带回新的 refresh_token，整体覆盖落盘 */
export async function refreshToken(cfg: Config): Promise<XeroToken> {
  const current = loadToken(cfg);
  if (!current?.refreshToken) throw new XeroAuthError('没有 refresh_token，需要重新走一次授权（xero token-url）');
  return requestToken(
    cfg,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.refreshToken }),
  );
}

/** 拿一个「现在就能用」的 access token：快过期就先换 */
export async function getValidToken(cfg: Config): Promise<XeroToken> {
  const current = loadToken(cfg);
  if (!current) throw new XeroAuthError('尚未授权：先跑 `xero token-url` 拿授权链接，再跑 `xero auth --code=...`');
  if (current.refreshToken && expiredAt(current, cfg.xero.expirySkewSec)) {
    return refreshToken(cfg);
  }
  return current;
}
