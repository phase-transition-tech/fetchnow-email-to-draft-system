/**
 * 本地假 Xero：只用来验证「我们发给 Xero 的请求长什么样」，不模拟会计业务。
 *
 * 存在的理由：阶段二要接真 Xero，但真接口要 OAuth 授权码 + tenant 绑定 + 网络，
 * 练手期没必要每次都为了回归去走一遍；这个假服务把端点形状（Invoices POST、
 * Attachments PUT、token 端点）和错误形态（401 / 429 / 重复发票号）都实现了，
 * 于是「请求体对不对、附件是不是单独传、限流有没有被正确识别」全都能离线断言。
 *
 * 用法：`node scripts/fake-xero.mjs --port 8787` 跑起来后打印出的 URL 填进
 * xero.baseUrl / xero.tokenUrl 即可。
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const OK = { _status: 'OK', ProviderName: 'FAKE-XERO' };

/**
 * @param {object} [opts]
 * @param {boolean} [opts.firstCallUnauthorized] 第一次建单返回 401（用来验证 refresh 后重试）
 * @param {number|null} [opts.rateLimitOnce] 前 N 次建单返回 429（用来验证限流被识别成可重试错误）
 * @param {boolean} [opts.allowDuplicate] 允许重复发票号（默认重复直接 400，模拟 Xero 的发票号唯一）
 * @param {object} [opts.existing] 预置发票号 → InvoiceID，模拟「上次已经建过单」
 * @param {boolean} [opts.requireBearer] 请求没带 Bearer 就 401（默认开）
 */
export function startFakeXero(opts = {}) {
  const state = {
    invoices: new Map(Object.entries(opts.existing ?? {})),
    attachments: [],
    calls: [],
    tokenCalls: 0,
    unauthorizedUsed: 0,
    rateLimitUsed: 0,
  };

  const record = (entry) => {
    state.calls.push(entry);
    return entry;
  };

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    // 真实 Xero 的路径是 /api/v3.0/Invoices；测试里 baseUrl 直接指向本服务根，所以要容忍两种写法
    const apiPath = path.replace(/^\/api\/v3\.0/, '') || '/';
    const raw = await readBody(req);

    // ---- token 端点：换 access / refresh ----
    if (path === '/connect/token') {
      /* token 端点，原样处理 */
      state.tokenCalls += 1;
      const body = new URLSearchParams(raw.toString('utf8'));
      record({
        method: 'POST',
        path,
        grant: body.get('grant_type'),
        auth: String(req.headers.authorization ?? ''),
        basicMatchesCredentials: body.get('client_id') === null, // Xero 走 Basic，这里只留痕不校验
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: `new-access-${state.tokenCalls}`,
          refresh_token: `new-refresh-${state.tokenCalls}`,
          expires_in: 1800,
          scope: 'openid offline_access accounting.transactions',
          token_type: 'Bearer',
        }),
      );
      return;
    }

    // ---- 建单 ----
    if (apiPath === '/Invoices' && req.method === 'POST') {
      const auth = String(req.headers.authorization ?? '');
      const body = JSON.parse(raw.toString('utf8') || '{}');
      record({ method: 'POST', path, auth, body: body.Invoices?.[0] ?? body, bytes: raw.length });

      if ((opts.requireBearer ?? true) && !auth.startsWith('Bearer ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ErrorNumber: '401', Description: '未带 token' }));
        return;
      }
      if (opts.firstCallUnauthorized && state.unauthorizedUsed === 0) {
        state.unauthorizedUsed += 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ErrorNumber: '401', Description: 'token 已过期' }));
        return;
      }
      if (opts.rateLimitOnce != null && state.rateLimitUsed < opts.rateLimitOnce) {
        state.rateLimitUsed += 1;
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': '2',
          'X-Rate-Limit-Reset': String(Math.floor(Date.now() / 1000) + 60),
        });
        res.end(JSON.stringify({ ErrorNumber: '429', Description: 'Rate limit exceeded' }));
        return;
      }

      const invoice = body.Invoices?.[0];
      if (!invoice) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ErrorNumber: '400', Description: '缺少 Invoices' }));
        return;
      }
      if (invoice.Type !== 'ACCPAY') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ErrorNumber: '400', Description: `Type 必须是 ACCPAY，收到 ${invoice.Type}` }));
        return;
      }
      const no = String(invoice.InvoiceNumber ?? '');
      if (!opts.allowDuplicate && no && state.invoices.has(no)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ErrorNumber: '400', Description: `发票号已存在：${no}` }));
        return;
      }
      const id = randomUUID();
      state.invoices.set(no || id, { InvoiceID: id, Status: invoice.Status ?? 'DRAFT', InvoiceNumber: no });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...OK, Invoices: [{ InvoiceID: id, Status: 'DRAFT', InvoiceNumber: no }] }));
      return;
    }

    // ---- 查重：GET ?InvoiceNumber= / ?where= ----
    if (apiPath === '/Invoices' && req.method === 'GET') {
      const no = url.searchParams.get('InvoiceNumber');
      const where = url.searchParams.get('where') ?? '';
      const needle = no ?? (where.match(/InvoiceNumber\s*==\s*"([^"]+)"/)?.[1] ?? '');
      record({ method: 'GET', path: `${path}${url.search}`, auth: String(req.headers.authorization ?? ''), invoiceNumber: needle });
      const hit = needle ? state.invoices.get(needle) : undefined;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...OK, Invoices: hit ? [{ InvoiceID: hit.InvoiceID, Status: hit.Status, InvoiceNumber: hit.InvoiceNumber }] : [] }));
      return;
    }

    // ---- 附件：必须建单之后单独传 ----
    const m = apiPath.match(/^\/Invoices\/([^/]+)\/Attachments\/(.+)$/);
    if (m && req.method === 'PUT') {
      const filename = decodeURIComponent(m[2]);
      state.attachments.push({ invoiceId: m[1], filename, bytes: raw.length, contentType: String(req.headers['content-type'] ?? '') });
      record({ method: 'PUT', path, auth: String(req.headers.authorization ?? ''), filename, bytes: raw.length });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...OK, Attachments: [{ AttachmentID: randomUUID(), FileName: filename }] }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ErrorNumber: '404', Description: `不认识的路由 ${req.method} ${path}` }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const handle = {
        baseUrl,
        tokenUrl: `${baseUrl}/connect/token`,
        state,
        close: () => new Promise((r) => server.close(r)),
        reset: () => {
          state.invoices.clear();
          state.attachments.length = 0;
          state.calls.length = 0;
        },
        invoices: () => [...state.invoices.values()],
      };
      resolve(handle);
    });
  });
}

export function defaultExportGuard() {
  throw new Error('本模块只导出 startFakeXero，别直接调用');
}
void defaultExportGuard;

/** 手动跑：`node scripts/fake-xero.mjs [--port 8787] [--ratelimit 1]` */
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const portFlag = argv.indexOf('--port');
  const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : 8787;
  const rateIdx = argv.indexOf('--ratelimit');
  startFakeXero({ rateLimitOnce: rateIdx >= 0 ? Number(argv[rateIdx + 1] ?? 1) : null }).then((h) => {
    console.log(`fake-xero 已启动：${h.baseUrl}`);
    console.log(`  建单      POST ${h.baseUrl}/api/v3.0/Invoices`);
    console.log(`  附件      PUT  ${h.baseUrl}/api/v3.0/Invoices/{id}/Attachments/{file}`);
    if (portFlag < 0) {
      // 随机端口时打一行能被复制走的 env 提示
      console.log(`  测试用     FN_XERO_BASE_URL=${h.baseUrl}`);
    }
  });
}
