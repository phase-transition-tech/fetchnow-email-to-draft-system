import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * 这里测的是「凭据怎么被读到」——上一版踩的两个坑都在这：
 *   1. CLI 不读 .env，填了变量也白填，`npm run demo` 悄悄只扫本地目录；
 *   2. Google 应用专用密码页面显示成 xxxx xxxx xxxx xxxx，带空格喂给 IMAP 会被判 Invalid credentials。
 * config 模块用 process.env 做单例快照，所以测试一律动态 import 拿全新实例。
 */
describe('配置：.env 自动加载与密码去空格', () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), 'fn-config-'));
  const saved: Record<string, string | undefined> = {
    FN_IMAP_USER: process.env.FN_IMAP_USER,
    FN_IMAP_PASS: process.env.FN_IMAP_PASS,
  };

  after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of ['FN_IMAP_USER', 'FN_IMAP_PASS']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** 用查询串破缓存，拿到重新读过 env 的新模块 */
  const fresh = (tag: string) => import(`../src/config.js?fresh=${tag}`) as Promise<typeof import('../src/config.js')>;

  it('.env 在项目根目录时自动生效，不用手写 --env-file=.env', async () => {
    writeFileSync(path.join(dir, '.env'), [
      '# 注释行',
      'FN_IMAP_USER=li@example.com',
      'FN_IMAP_PASS=abcd1234efgh5678',
      '',
    ].join('\n'));
    process.chdir(dir);
    // 用几个不会污染真实 .env 的键，避免顺手连上用户邮箱
    const cfg = (await fresh('dotenv')).loadConfig();
    assert.equal(cfg.ingest.imap.user, 'li@example.com');
    assert.equal(cfg.ingest.imap.pass, 'abcd1234efgh5678');
  });

  it('shell 里已有的环境变量优先于 .env，.env 不会把临时 export 覆盖掉', async () => {
    process.env.FN_IMAP_USER = 'shell-wins@example.com';
    const cfg = (await fresh('precedence')).loadConfig();
    assert.equal(cfg.ingest.imap.user, 'shell-wins@example.com');
  });

  it('应用专用密码带空格也要剥干净（Gmail 只认连续 16 位）', async () => {
    delete process.env.FN_IMAP_USER;
    process.env.FN_IMAP_PASS = 'abcd efgh ijkl mnop'; // Google 页面上就是这么显示的
    const cfg = (await fresh('pass')).loadConfig();
    assert.equal(cfg.ingest.imap.pass, 'abcdefghijklmnop');
    assert.equal(cfg.ingest.imap.pass.length, 16);
    assert.ok(!/\s/.test(cfg.ingest.imap.pass));
  });

  it('.env 不存在或解析出错时，静默退回默认值而不是崩掉', async () => {
    process.chdir(dir); // 只有 .env，没有 .env 的这个子目录
    const sub = path.join(dir, 'no-env-here');
    mkdirSync(sub, { recursive: true });
    process.chdir(sub); // 这个目录里没有 .env
    delete process.env.FN_IMAP_USER;
    delete process.env.FN_IMAP_PASS;
    const cfg = (await fresh('missing')).loadConfig();
    assert.equal(cfg.ingest.imap.user, '');
  });
});
