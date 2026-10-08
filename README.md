# fetchnow-email-to-draft-system

#541 练手项目：供应商发票邮件 → Xero 账单草稿。
**自动收票、自动抄字段、拿不准的标黄喊人；签字权留给财务，终态永远是 DRAFT。**

## 三分钟跑起来（阶段一，完全离线）

```bash
npm install
npm run fixtures    # 造 4 封测试邮件（含一张正常发票、一张扫描件、一张金额不自洽、一封垃圾邮件）
npm run demo        # 收件 → 人工确认门 → 串行处理 → 落一份草稿
npm test            # 17 个测试函数（四条验收用例 + 阶段二/三的联调与纯逻辑）
node --import tsx src/cli.ts list
```

阶段一跟真 Xero、真邮箱都没有关系：**本地目录当收件源**，`MockXeroAdapter` 当交付端。
阶段二/三已经把真接口路径和真实收件层写出来了，但默认仍走 folder + mock，
没有凭证也能跑（凭证怎么填见下面「接真环境」）。

## 发票识别：不用 AI 模型

`pdfjs` 抽文本层 → 判版式（中文数电发票 / 英文发票）→ 规则抽取字段，每条字段带置信度和溯源
（`native:sellerBlock` 这类）。认不出来就转人工，不瞎填。

唯一需要「模型」的地方是**扫描件**（PDF 没文本层）—— 那一步是 OCR，现在 `extract.ocrEnabled = false`，
直接落 `OCR_NEEDED` 转人工。

中文数电发票（全电发票）有一套独立模板 `src/extract-cn.ts`，样本在
`fixtures/samples/cn-einvoice-sample.pdf`，规则细节见 `ARCHITECTURE.md` §2.5。

## 文档索引

| 文档 | 读什么 |
| --- | --- |
| `ARCHITECTURE.md` | **整体实现架构**：分层与模块、状态机详解、四条验收用例详解、IMAP/IDLE 详解、中文发票模板，以及阶段二三的实施说明 |
| `PLAN.md` | 注意事项与踩坑清单（51 条）、配置速查、分阶段路线、阶段一跑法 |

想先知道「系统怎么跑、为什么这样设计」→ 读 `ARCHITECTURE.md`。
想知道「正式接邮箱/接真 Xero 之前要注意什么」→ 读 `PLAN.md`。

## 目录

```
config/default.json       全部可调参数
fixtures/inbox/*.eml      验收用测试邮件（npm run fixtures 生成）
fixtures/samples/         真实中文数电发票样本 + 对应提取测试
scripts/
  make-fixtures.mjs       离线造数据（最小手写 PDF + .eml 构造）
  fake-xero.mjs           本地假 Xero：验证「发给真接口的请求长什么样」，零凭证可跑
src/
  types.ts                Field<T>（值 + 置信度 + 溯源）、状态、Flag 枚举
  config.ts               配置加载、路径解析
  db.ts                   schema、幂等 upsert、事件流
  ingest.ts               folder / imap 两路收件源
  imap.ts                 IMAP 收件层：水位 uidValidity、增量窗口、探活
  extract.ts              判版式 → 分流到中文模板或英文正则
  extract-cn.ts           中文数电发票（全电发票）模板：20 位号码、¥ 金额、销售方税号锚点
  validate.ts             规则引擎：金额自洽、税率、日期、重复发票号
  xero.ts                 适配器：mock + 真 API（401 换 token 重试、429 限流、附件二次上传）
  xero/oauth.ts           Xero OAuth2：授权链接、code 换 token、refresh 轮换落盘
  pipeline.ts             编排：收件 / 纳入 / 串行处理 / watchers
  cli.ts                  scan / list / show / admit / process / retry / reconcile / xero … / imap …
test/
  pipeline.test.ts        四条验收样例的自动化断言
  xero.test.ts            真接口适配器 + 流水线端到端（打本地假 Xero）
  imap.test.ts            IMAP 纯逻辑（SINCE 格式、水位推进、uidValidity 失效）
data/                     运行时产物（gitignore）：sqlite、附件、草稿、token、imap 水位
```

## 常用命令

```bash
npm run typecheck   # 类型检查
npm test            # 测试
npm run demo        # 端到端跑一遍完整闭环
npm run scan        # 只收件
npm run process     # 只处理队列
npm run watch       # ★ 全自动闭环常驻：收件 → 白名单自动纳入 → 处理（--once 只跑一轮）
npm run watch -- --once
npm run list        # 看任务队列（--status observed 只看观察池）
npm run show -- 7   # 单条任务详情 + 事件流
npm run admit -- --all       # 观察池整批纳入
npm run retest      # ★ 再测一遍：把最后一条已建单的票倒回起点重跑（可跟 id）
npm run retest -- --from-mail   # 连收件一起重来（会清掉邮件记录，让 scan 真重收一遍）
npm run retry -- 2  # 重推（同一幂等键，不会重复建单）
npm run reconcile   # 模拟每日对账
```

### 想再测一遍同一张发票？

同一封邮件第二次收会被**两层去重**挡下（邮件按 messageId、发票按附件 sha256），所以「再测一遍」
不能靠重发邮件。用 `retest` 把状态倒回去即可：

```bash
npm run retest                    # 只重跑后半段：纳入 → 建草稿（挑最后一条已建单的票）
npm run retest -- 7               # 指定票
FN_INGEST_MODE=folder npm run retest -- --from-mail   # 连收件一起重来，且不碰邮箱
```

`retest` 会顺手把这张票上一次生成的草稿 json 删掉，不会留孤儿文件。
`--from-mail` 适合验「收件 → 入库 → 纳入 → 建草稿」的完整链路；不带它则只验后半段。

## 让它真的自动：发一封带发票的邮件 → 出一份草稿

收件是自动的，**但「自动纳入」和「自动处理」默认都是关的**——这是刻意的人门。
想全自动（示例：从你自己的 QQ 邮箱发一张中文数电发票到那个 Gmail，几十秒后 `data/xero-drafts/`
里多一份 json 草稿），只做两步：

```bash
# 1) 把发件人域名加进自动纳入白名单（config/default.json 的 review.autoAdmitDomains）
#    自己 testing 时用环境变量更省事，不用改文件：
export FN_AUTO_ADMIT_DOMAINS=qq.com          # 多个用逗号：qq.com,foxmail.com
# 2) 一条命令常驻（Ctrl+C 停），或者只跑一轮看看
npm run watch            # 常驻：收件 → 白名单纳入 → 处理（IDLE 下秒级触发，兜底最多 5 分钟）
npm run watch -- --once  # 只跑一轮（调试时用它，免得挂着占终端）
```

跑起来会长这样（每有动静才打一行，没动静就安静地等）：

```
自动纳入白名单：qq.com（命中即自动处理，其余仍等人确认）

收件：IMAP 长连接 + auto-IDLE（imapflow 自动进出 IDLE，25 分钟重进一次），兜底轮询 300 秒
自动闭环已启动，Ctrl+C 退出

扫描 6 封：新入库 1，重复 0，被过滤 1
自动纳入（白名单命中）：1 条，仍在等人工确认 0 条
处理 1 条：建草稿 1，转人工 0，重试 0，死信 0，跳过 0
```

**关于即时性**：`imap.idle = true` 时邮件一到就跑处理（秒级），不用等那 5 分钟；兜底轮询仍然保留，
所以就算推送那条线死了，最多也是 5 分钟——两条路互为备份。开 IDLE 的代价只有一个：**它需要有个常驻进程**，
`npm run watch` 一关就回到轮询。不想常驻就关掉 `imap.idle`，改 cron/launchd 定时跑 `npm run scan`。
（IDLE 只监听被选中的那个邮箱，默认 `INBOX`；给发票邮件设过 Gmail 过滤规则直接归档到标签的话，
它和轮询都看不见——详见 `ARCHITECTURE.md` §5.9。）

**如果看到 `Client network socket disconnected before secure TLS connection was established`**：
这是**服务端在限流**，不是密码错、也不是网络不通（同一个 Google 的 `smtp.gmail.com:465` 照样通）。
密集重连会触发它，而且**每次重试都在给这个惩罚续期**。正确做法是：`Ctrl+C` 停掉 `watch`、
别开第二个终端去连同一个邮箱、等几分钟到十几分钟，再用 `npm run imap-check` 确认（它只连一次）。
`watch` 已经改成阶梯退避（2s → 10s → 30s → 2min → 10min，带 ±15% 抖动），日志里会直接写出「第几次、
多少秒后重连」，不会再去自杀式重连。完整排查过程见 `ARCHITECTURE.md` §5.8。

**仍然不会自动的环节**（这几条是设计，不是没做完）：

- 到 `DRAFT` 就停，**不会自动 Approved**，Xero 里还得你点 Approve；
- 不在白名单的、或者提取/校验有 flag 的（金额算不平、缺字段、扫描件没 OCR），一律停在 `review` 等人看；
- 白名单空着就**永远等人确认**——别为了省事把 `autoAdmitDomains` 设成 `["*"]`。

配套的 `filters.allowedSenderDomains` 是另一回事：**垃圾过滤**。它非空时，不在列表里的发件人
连观察池都不进（收件箱照样收，只是不生成任务）。按**域名**比，配 `vendor.com` 就同时放行
`boss@vendor.com` / `ap@vendor.com`。两个列表的差别：

| 配置 | 作用 | 谁受影响 |
| --- | --- | --- |
| `filters.allowedSenderDomains` | 兜底过滤：挡在观察池外，进 `filtered` 表可查 | 白名单外的**所有**邮件 |
| `review.autoAdmitDomains` | 跳过「人点 admit」，直接进处理队列 | 白名单内的（其他票照样进池子等人筛） |

> 沙箱环境里 IMAP 的 993 端口可能被掐，`both` 模式下会自动降级只扫目录并在事件流留一条 warn，
> 不会让整条命令挂掉——所以自测时看到的「扫描 N 封」可能只有目录那 5 封。想确认邮箱那路真的活着，
> 跑 `node --import tsx src/cli.ts imap check`，看它有没有打出「探活通过」和那串邮件数。

## 接真环境（需要你自己的账号，与代码无关）

> **默认不需要走这一节。** `config/default.json` 里 `xero.provider = "mock"`，
> 也就是说 `npm run demo` / `npm test` / `npm run scan` 全程只往 `data/xero-drafts/*.json` 写本地草稿，
> 不调 Xero、不做 OAuth。下面这些命令是**你准备换真环境时才**要跑的。
>
> `ingest.mode` 现在是 `both`（真邮箱 + `fixtures/inbox` 双跑）。`npm test` / `npm run demo`
> 也会读 `.env`（自动加载），但**不会真的去连邮箱**：`npm test` 和 `npm run demo` 都不走收件，
> `npm run demo` 只是把 `fixtures/inbox` 里那 5 封（含一封中文数电发票）跑一遍流水线。只有 `npm run scan` 才真正连邮箱，
> 而 `FN_IMAP_USER` / `FN_IMAP_PASS` 没填时它只扫目录、在事件流里留一条 warn，不会挂掉。
> 想彻底离线就改回 `"folder"`。

### 先把 Xero 账号搞定（个人能注册，但有三个前提）

**不需要企业资质。** 个人（sole trader / 个人开发者）就能注册，开发者平台 `developer.xero.com`
本身免费，30 天试用不需要信用卡。但别直接冲「注册公司 → 接 API」，先看这三条：

1. **组织辖区只有 7 个**：澳大利亚、新西兰、英国、美国、加拿大、新加坡、南非。
   中国大陆主体不在其中（Xero 不做中国税制）。要建真实组织就得挂一个上述辖区，
   而且试用期结束后需要海外支付方式。
2. **只想跑通 API 流程，用 Demo Company 就够了**：开发者账号自带一个预置数据的
   Demo 组织，授权时选中它即可，免费、不占订阅、不碰真实账套。数据会被 Xero 定期重置，
   别把长期数据放进去。
3. **建 ACCPAY 账单前，供应商联系人必须已经存在 Xero**（账单要带 `ContactID`）。
   Demo Company 里没有你的供应商，第一次跑会撞 400——手动加一个联系人，或者
   由代码在找不到时自动建（目前没有，属于待补）。CNY 中文票还要另算税码/科目映射（见 `PLAN.md` 第 51 条）。

开发者应用怎么配（对应本项目的 `xero.*` 配置）：

| 配置项 | 在 Xero 里填什么 |
| --- | --- |
| App name | 随便起，**别含 "Xero" 字样** |
| Integration type | Web app（本项目走 auth code + client secret） |
| Redirect URI | **必须和 `config/default.json` 的 `xero.redirectUri` 逐字一致**：`http://127.0.0.1:54545/callback`（端口、结尾斜杠、大小写都不能差） |
| Scopes | 本项目已要够：`offline_access accounting.contacts accounting.transactions` |
| Client secret | 只显示一次，离开页面就没了；存进 `.env` 的 `XERO_CLIENT_SECRET` |

拿到 clientId/secret 后就能用下面第 3 步那三条命令（`xero token-url` → `xero auth` → `xero check`）。

### 2. 真邮箱（Gmail）

四个环境变量在 `.env` 里这样填：

| 变量 | 填什么 |
| --- | --- |
| `FN_IMAP_USER` | **完整邮箱地址**（`invoices@gmail.com`，Workspace 就写 `invoices@公司域名`） |
| `FN_IMAP_PASS` | **应用专用密码**，不是账号登录密码 |
| `FN_IMAP_HOST` | `imap.gmail.com`（默认值，可不填） |
| `FN_IMAP_PORT` | `993`（默认值，可不填） |

Gmail 专用密码怎么拿：

1. **开两步验证** — 右上角头像 → 管理你的 Google 账号 → 安全 → 两步验证。
   最后一步会问「是否设置使用应用专用密码的替代方式」，个人 Gmail 账号**必须选「是」**（安全密钥那步可以跳过），否则 2FA 开不下去。
2. **生成专用密码** — 2FA 开完后，安全页会出现「应用专用密码」，或直连
   https://myaccount.google.com/apppasswords → 起名 → 生成，拿到一串 16 位（只显示这一次）。
3. 粘到 `FN_IMAP_PASS`。Google 页面上它显示成 `xxxx xxxx xxxx xxxx`，
   **粘进 `.env` 时空格留着也没关系** —— 配置层会自动剥掉所有空白
   （Gmail 认证只认连续 16 位，带空格会报 `Invalid credentials`）。

> **IMAP 不用手动开。** 新版 Gmail（设置 → 转发和 POP/IMAP）里已经没有「启用 IMAP」这个开关了，
> IMAP 默认就是启用的，那一页只剩 POP 开关和「IMAP 邮件被删时怎么处理」的策略。
> 这一页保持这样就行：POP 保持停用、删除策略选「停用自动清除 + 归档邮件」。
> `imap check` 连得上本身就证明 IMAP 是开的，不必先到设置里确认。

Google 早就关掉了「允许不够安全的应用」那个老开关，**登录密码直接喂给 IMAP 一定会被拒**，
报的是 `Invalid credentials`，别往「密码错了」上想。

> `FN_IMAP_HOST` / `FN_IMAP_PORT` 这两个变量现在会真的生效（`src/config.ts` 读）。
> 换 Outlook / Zoho / 自建 dovecot 时才改，Gmail 用默认值就行。

### 2. 别忘了切收件源

`FN_IMAP_USER` 填了只是一半——收件源由 `config/default.json` 的 `ingest.mode` 决定。
现在是 `"both"`（真邮箱 + `fixtures/inbox` 双跑），也就是说上面那四个变量**已经生效**了。
想只连邮箱就设成 `"imap"`；想完全离线验就设回 `"folder"`。

顺序不要跳，每一步都有对应命令验证：

```bash
# 1) 收件源（config/default.json 现在已经是 "both"，可跳过这步）
#    想只连真邮箱就设成 "imap"；"both" 是真邮箱 + fixtures 双跑，方便对照

# 2) 真邮箱：只探活、不入库，看连接/邮箱/邮件数对不对
node --import tsx src/cli.ts imap check

# 3) 真 Xero：拿授权链接 → 换 token → 确认 scope 与 tenant 通
node --import tsx src/cli.ts xero token-url
node --import tsx src/cli.ts xero auth --code=回调里拿到的code
node --import tsx src/cli.ts xero check

# 4) 都通过了才把 provider 从 mock 换成 xero
#    config/default.json → xero.provider = "xero"（或 export FN_XERO_PROVIDER=xero）
```

账号凭据见 `.env.example`（复制成 `.env`，`.env` 已在 `.gitignore` 里）。
**`.env` 会自动加载**，不用手写 `--env-file=.env`；shell 里 `export` 的 `FN_*` 优先于 `.env`，
所以临时覆盖仍然有效。

## 零凭证验证真接口路径

不想走 OAuth 也能验证「发给 Xero 的请求形状对不对」：

```bash
node scripts/fake-xero.mjs --port 8787     # 起一个假 Xero
# 把 xero.baseUrl / xero.tokenUrl 指向 http://127.0.0.1:8787 后跑 npm test
# test/xero.test.ts 会用它在 CI 里断言：请求体形状、附件单独 PUT、429 识别、401 换 token 重试
```

需要 Node ≥ 22.5（`node:sqlite`）。
