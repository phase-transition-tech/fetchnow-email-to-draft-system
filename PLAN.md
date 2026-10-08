# fetchnow-email-to-draft-system 整体方案（#541 练手版）

> 目标案例：供应商发票邮件 → Xero 账单草稿（draft bill）。
> 一句话：**自动收票、自动抄字段、拿不准的标黄喊人，签字权永远留给财务。**

## 0. 目标与非目标

**做**

- 邮件收票 → 观察池 → 人工确认纳入 → 自动提取 → 规则自校验 → 建 Xero 草稿
- 全程终态是草稿（DRAFT），不付款、不记账、不自动批准
- 同一封邮件（或同一份 PDF 重发）重试任意次，只产生一张账单

**不做（一期）**

- 不接真 Xero 的 OAuth2 授权码流程（阶段二再换适配器）
- 不做 PO 匹配、贷项通知单、付款批次、GL 编码、多币种申报
- 不做多租户、不做 Web 服务、不做登录鉴权（本机单用户）
- OCR 默认关闭：扫描件直接转人工，不引入识别质量的黑盒

## 1. 技术选型

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node 22（本机 22.22） | 仓库已有 Electron 技术栈，收件器可原样搬进 main 进程 |
| 存储 | `node:sqlite`（内置，实验标志无需开启） | 零原生依赖；真要进 Electron 时换成 `better-sqlite3` 即可 |
| IMAP | `imapflow` | Promise API，自动识别 IDLE/CONDSTORE/QRESYNC；**不自动重连，需要自己写退避** |
| 邮件解析 | `mailparser` | 负责 multipart / base64 / 编码细节，只交付 envelope 与附件字节 |
| PDF 文本层 | `pdfjs-dist`（legacy 入口） | 取原生文本层，能拿到页码用于溯源 |
| 任务调度 | 进程内串行 worker + 数据库队列 | 一天几张票，串行足够，且重启后队列不丢 |
| 交付形态 | CLI + 库 | 先跑通，后面被 fetchnow-workflow 四个面板直接消费 |

## 2. 目录结构

```
fetchnow-email-to-draft-system/
  config/default.json          全部可调参数（白名单/容差/退避/OCR 开关）
  data/                       运行时产物（gitignore）：sqlite、附件、草稿
  fixtures/inbox/*.eml        验收用测试邮件（npm run fixtures 生成）
  scripts/make-fixtures.mjs   手写最小 PDF + 构造 .eml，离线造数据
  src/
    types.ts                  Field<T>（值 + 置信度 + 溯源）、状态、Flag 枚举
    config.ts                 配置加载与路径解析
    db.ts                     schema、幂等 upsert、事件流
    ingest.ts                 folder / imap 两个源 → 落盘附件 → 建任务
    extract.ts                PDF 文本层 → 字段（带置信度与页码溯源）
    validate.ts               规则引擎：金额自洽、税率、日期、重复发票号
    xero.ts                   适配器：mock（阶段一）与真 API 骨架（阶段二）
    pipeline.ts               编排：收件 / 纳入 / 串行处理 / watcher
    cli.ts                    scan / list / show / admit / process / retry / reconcile
  test/pipeline.test.ts       四条验收样例的自动化断言
```

## 3. 数据流与状态机

> 状态机的八状态定义、迁移表、四条验收用例逐条展开、IDLE 是什么，见 `ARCHITECTURE.md` 第 3 / 4 / 5 章；这里只给全景。

```
邮箱（专用别名 invoices@）
  → IMAP 轮询（5 分钟）/ IDLE（可选）→ 落盘附件（sha256 命名）
  → messages 表 upsert（Message-ID 唯一）→ 观察池 invoices.status = observed
  → 人工在「待开票输入」点纳入 → admitted
  → worker 串行：extract → validate
      无 flag → adapter.createDraftBill → created（provider_ref = Xero InvoiceID）
      有 flag → review（面板上标黄等人）
      异常 → attempt_count+1 退避重试 → retry → 超过 maxAttempts → dead（可手动重推）
事件流 events 表 → 实时动态面板
```

| 面板 | 消费的数据 |
| --- | --- |
| 待开票输入 | `status = observed / review` 的发票 + 字段预览 + 标黄原因 |
| 任务队列 | 全部 task、attempt_count、失败原因、死信重推 |
| 队列操作 | 重试 / 取消 / 强制重建（都走同一幂等键） |
| 实时动态 | `events` 表按时间倒序 |

## 4. 数据模型

- `messages`：`message_id` 主键（邮件头的 Message-ID）
- `filtered`：被过滤器挡掉的邮件及原因，供每日对账复核（防止白名单写错）
- `invoices`：**`sha256 UNIQUE`** —— 整张系统的幂等支点；含提取字段快照、flags、confidence、provider_ref、attempt_count、due_at
- `events`：状态变更流水，实时动态面板直接读

关键约束就两条：`messages.message_id` 主键 + `invoices.sha256` 唯一索引。其余字段都是给人看的。

## 5. 幂等设计（最重要的设计决策）

推送、轮询、重连都会重复报同一封邮件，**协议层不保证只推一次**（Gmail 的 Pub/Sub 是至少一次投递，IMAP 的 UID 也会重报）。所以：

1. `message_id` 主键挡住「同一封邮件进来两次」；
2. `sha256(附件字节)` 唯一索引挡住「同一份 PDF 换封邮件重发」——命中时是 `duplicate`，只记一条 warn 事件，**不新建任务**；
3. 真要更新同一张票，走 `admit / retry` 改状态，绝不删库重建；
4. 结果层兜底：Xero 建单前查 `invoices.provider_ref` 是否已存在，已存在的直接返回，不发第二个 POST。

这样「同一邮件重试不重复建单」这条验收样例，是**结构保证**而不是靠测试覆盖。

## 6. 模块职责

- **ingest**：过滤（发件域 / 附件类型 / 体积）→ 附件落盘（同名同 hash 只写一次）→ 建任务
- **extract**：取文本层（页码溯源）→ 正则提字段 → 每个字段带 `value / confidence / source`
- **validate**：规则引擎，输出 `ReviewFlag[]`；`review.autoCreateWhen = "no-flags"` 表示只有零 flag 才自动建草稿
- **xero 适配器**：`MockXeroAdapter` 写 JSON 到 `data/xero-drafts/`（阶段一）；`XeroApiAdapter` 是 POST `/Invoices` 的骨架（阶段二）
- **pipeline**：串行取任务、写状态、记录事件，失败退避与死信

## 7. 特别要注意的细节

### 7.1 收件层

1. **用专用别名，别监控个人邮箱**。`invoices@yourdomain.com`，并配好收件方 SPF/DKIM——进垃圾箱是最沉默的失败，查起来会浪费一下午。
2. **不要用 `UNSEEN` 当唯一水位**。你用网页版看过一次，未读标记就消失了。水位应存本地 `UID + uidValidity`，必要时再叠加 `SINCE`（Gmail 严格要求 `DD-Mon-YYYY` 且按 UTC 算）。
3. **IDLE 必须周期性重连**。RFC 2177 允许服务器 30 分钟掐连接，Gmail 实测约 29 分钟，且不报错、静默失联。做法：25 分钟主动重连（imapflow 的 `maxIdleTime`）+ 5 分钟轮询兜底，两者互为备份。
4. **imapflow 不会自动重连**，监听 `close` 事件自己写指数退避（30s/60s/120s/…上限 300s）。
5. **连接数**：Gmail 每账号 15 条并发 IMAP 连接、约 2.5GB/天配额。收件器单连接、处理完就关，别开连接池。
6. **系统睡眠唤醒后强制补扫一次**，macOS 挂起后长连接基本全死。
7. **首次运行要 backfill**：扫最近 N 天带 PDF 的邮件入库，否则之前攒的票永远不进来。
8. **Gmail 的标签不是文件夹**：同一封可以同时属于 Inbox / Starred / All Mail。给发票打 `Invoices` 标签后用 `X-GM-LABELS` 定位，比扫 All Mail 准得多。老账号超过约 100 万封后 IMAP 只暴露最旧的 100 万封，新邮件不可见，届时要换 Gmail API。

### 7.2 解析层

9. **扫描件没有文本层时不要硬上 OCR 糊弄**。默认 `ocrEnabled = false`，直接报 `OCR_NEEDED` 转人工——这是「黑盒系统」最容易翻车的地方。
10. **字段必须带溯源**（`source = "native:p1"`），出问题能翻回原发票第几页核对；这是客户明确要的能力。
11. **先拉信封再拉正文**。检测过信封确认是发票，再取 PDF 字节，省流量也少踩配额。
12. **别信文件名和主题**：扫描件常叫 `scan_001.pdf`，营销邮件主题写着 "Invoice"。判断依据应是发件域 + PDF 内部结构 + 后续提取置信度。
13. **日期格式歧义**：`27/09/2026` 是日/月还是月/日？非欧美格式优先按日/月解析，并在面板上把解析结果显式展示让人确认。
14. **到期日缺失时按账期推算可以，但置信度降级为 medium**，并写明是推算值，不能当原文抄的。
15. **PDF 加密/损坏**：`pdfjs` 直接失败，要落到 `OCR_NEEDED` 而不是抛栈崩溃。

### 7.3 校验层

16. **金额自洽：明细之和 + 税 = 总额，差一分钱也不静默通过**（容差 0.01，建议按供应商货币设）。
17. **税率分母用净额**：含税总额下要用 `tax / (total - tax)`，直接除总额会把 10% 算成 9.09%，然后误报异常。
18. **`LineAmountTypes` 必须显式写 `Inclusive`**：默认值是 `Exclusive`（Xero 自己加税），供应商发票总额几乎都是含税的，写错等于税算两遍。
19. **同供应商 + 同发票号**再出现一次要报 `DUPLICATE_INVOICE_NO`：可能是供应商重发，也可能你之前漏了一张，必须人判断。
20. **置信度不是质量保证**：任何一个 flag 都进人工复核，永远不要出现「模型说 90% 把握就放行」。

### 7.4 写入层

21. **附件必须建单之后再传**：`POST /Invoices/{InvoiceID}/Attachments/{filename}`，body 是**原始字节流不是 JSON**，且文件名不能含 `, : " / \ | ? *`。
22. **终态检查**：mock 与真适配器都只写 `status = DRAFT`，代码里不存在任何「批准」动作；真接口只发 `Type: ACCPAY` + `Status: DRAFT`。
23. **串行写单**：Xero 限 5 并发 / 60 次每分钟，一天几张票串行最好推理，也让幂等更容易验证。
24. **失败要可重推**：`attempt_count` + 退避（5s/15s/45s）+ 死信，重推走同一幂等键，不会多出一张单。
25. **邮件在邮箱被删/移动，不要自动撤销 Xero 草稿**——草稿已经存在会计记录里，撤销要人来做。

### 7.5 人工审核层

26. **观察池这道门不能省**：收进来先 `observed`，人在「待开票输入」点纳入才进入处理，避免垃圾邮件/群发/带 PDF 的营销邮件被当发票处理。
27. **标黄要写清楚为什么**：`flags` 里带人类可读原因（"金额不自洽：3420.50 + 342.05 ≠ 9999.00"），不要只给个状态码。
28. **人工修正要能追溯**：修正前的提取结果整份存在 `extracted` 字段，别覆盖掉原始快照。
29. **`filtered` 表是对账入口**：每天看一眼被挡掉的邮件，能尽早发现白名单写错。

### 7.6 调度与运维

30. **不要只用「每天定时扫一次」当主通道**：发票什么时候来不知道，一天扫一次意味着晚上到的票要等第二天。轮询 5 分钟是保底线，凌晨全量对账是兜底线。
31. **每日对账**：扫最近 7 天所有带 PDF 的邮件比对 `invoices` 表，补齐漏网并输出「被挡掉但像发票」的清单。
32. **日志不要开 `logRaw`**，邮件正文敏感，会落盘。
33. **并发访问信箱用 `getMailboxLock()`**，裸 `mailboxOpen` 会在并发时切串信箱。
34. ** tribal knowledge 落配置**：供应商白名单、容差、GST 税率列表、退避时长全部进 `config/default.json`，不写死在代码里。

### 7.7 安全与隐私

35. **凭证不落明文**：Gmail 用应用专用密码或 OAuth2；Outlook/Exchange 的 Basic Auth 已于 2024 年 9 月全量下线，只剩 XOAUTH2。存盘用 Electron `safeStorage`（macOS 挂钥匙串）。
36. **发票 PDF 含供应商商业信息**，落盘路径与目录权限要按敏感数据处理，别丢进临时目录。
37. **不要因为「方便」给单条任务放开无限重试**：死信必须可见、可停止。
38. **新版 Gmail 没有「启用 IMAP」开关**（2024 改版后的「转发和 POP/IMAP」页只剩 POP 开关与删除策略，IMAP 默认启用）。所以「打不开邮箱 INBOX」不要去设置里找开关，九成是专用密码不对。
39. **2FA 末页的「是否设置应用专用密码的替代方式」个人号必须选「是」**，安全密钥那步可跳过；选错会导致两步验证开不起来。
40. **`ingest.mode = both` 时邮箱没配好不要抛错**：双跑的意义就是一路坏了另一路还能跑，所以 `runIngest` 在 both 模式下缺 `imap.user/host` 只记一条 warn 并扫目录；纯 `imap` 模式仍硬抛（宁可失败也不默默收不到票）。
41. **CLI 不读 `.env` 时，「变量明明填了」和「根本没填」看起来一模一样**：`.env` 里 `FN_IMAP_USER` 早就填好了，但 `npm run demo` 没带 `--env-file=.env`，`im.user` 是空串，于是整条 scan 静默降级成只扫 `fixtures/inbox`——输出「扫描 4 封」看着完全正常，极易误判成「邮箱已经连上了」。修法：在 `config.ts` 里加 `loadDotenvIfPresent()`（手写解析、零依赖，只补进程里还没有的键，所以 shell 的 `export` 与 `--env-file` 注入不会被 `.env` 覆盖），并且 `imap check` 一上来先把「读到没读到账号」打印出来，读不到就直接返回，别让人对着 TLS 报错猜。
42. **Google 应用专用密码带空格 = 直接认证失败**：页面上显示成 `xxxx xxxx xxxx xxxx` 是分组展示，IMAP 认证只认连续 16 位，喂带空格的串一律 `Invalid credentials`。在 config 层用 `.replace(/\s+/g, '')` 兜住，`.env` 里照抄带空格的版本也能连；`test/config.test.ts` 钉死了这条行为。
43. **「扫描 4 封」这个数字不能当证据**：4 是 `fixtures/inbox` 里的 fixture 数量，不是邮箱里的邮件数。`both` 模式下 `runIngest` 会把两路 scanned 相加，所以邮箱的邮件一旦被扫进来，这个数字会明显超过 4——**它才是「邮箱真的被读了」的第一个信号**，比任何日志都快。
44. **`npm run scan --watch` 的 `--watch` 会被 npm 吃掉**（2026-10-05 实测踩到）：npm 把位置参数之后的 token 当成自己的 flag 处理，不会传给 script，结果脚本跑完一次扫描就退出了，看着跟「轮询在跑」一模一样。正确写法是 `npm run scan -- --watch`（`--` 才是透传分隔符）。**判断依据**：输出里没有「后台扫描已启动，Ctrl+C 退出」这一行，就说明 watch 根本没生效。
45. **`updateInvoice` 里绝不能 `String(patch[k] ?? null)`**（真 bug，已修）：补丁类型本来就允许 `null` 表示「写 SQL NULL」，但 `String(null)` 得到的是字面量 `"null"` —— 一个 truthy 字符串，于是 `invoice_no` / `total` 在库里存成了 `"null"` 而不是 NULL。`!row.total` 这种「字段缺失」判断会全部失效（缺失的字段反被当成有值）。正确写法是 `patch[k] ?? null`，让驱动直接绑 NULL。`test/db.test.ts` 锁了这个回归点。
46. **`findVendor` 必须排除发票模板行**（已修）：原逻辑只看「长度 <60、>2、不含数字」就给 high 置信度，而中文数电发票恰好把「电子发票（普通发票） 发票号码：」整行顶到文本最前（英文发票同理以 `TAX INVOICE` 开头），于是抓出 `vendor = "电子发票（普通发票） 发票号码："` 还标着 high。现在加 `VENDOR_TEMPLATE_LINE` 黑名单跳过模板行；全被跳光时降级走 `fallback:p1` + low，至少不再拿鬼话冒充高置信。
47. **中文数电发票（全电发票）已支持（新增 `src/extract-cn.ts`）**：真实样本见 `fixtures/samples/cn-einvoice-sample.pdf`。三条踩点——① 号码是**固定 20 位数字**，比数「发票号码：」后隔几行稳（中间夹着发票号/日期）；② 供应商取**最后一个 18 位税号的上一行**（双栏布局里卖方块排在买方块之后），数「名称： 名称：」后第几行必错；③ 明细八栏全挤成一行（`*生产生活服务*餐饮服务 1%桌 712.87 7.13712.8712871287131`），**只认带小数点的数**，`1287131` 这种拼接整数自动出局。
48. **`allowedGstRates` 已改名 `allowedTaxRates`**：中文票 1% 不在原白名单 `[5%,10%,15%]`，而 `validate` 里 **warn 也计入 `flags.length`**，`autoCreateWhen=no-flags` 下 warn 一样挡住建单——所以税率白名单不扩，中文票永远建不出草稿。现列表 `[0.01,0.03,0.05,0.06,0.09,0.1,0.13,0.15]` 同时容纳增值税与 GST。
49. **`both` 模式下邮箱「配好了但连不上」也要降级**（继 40 条只覆盖「没配好」）：网络和 TLS 属于运行时波动，不该掀桌。现在 `runIngest` 的 both 分支 catch 住 imap 异常，事件流记一条 warn + 控制台提示，再回落到扫目录。纯 `imap` 模式仍硬抛。
50. **`npm run demo` 在 both 模式会去连邮箱**：沙箱里 TLS 被掐（993 端口出去就被 reset）时旧代码整条崩溃；修完 49 之后只打印「（邮箱连接失败，本轮只扫目录）」继续跑。自己终端能连就没这行字。
50. **个人能注册 Xero，不需要企业资质**：sole trader / 个人开发者即可，30 天试用不收信用卡，`developer.xero.com` 平台本身免费。真正的门槛是**组织辖区只有 AU/NZ/UK/US/CA/SG/ZA 七个**，中国大陆主体不在内（Xero 无中国税制）。只想跑通 API 流程就用开发者账号自带的 **Demo Company**，免费且不动真实账套，代价是数据会被 Xero 定期重置。
51. **建 ACCPAY 账单前供应商联系人（Contact）必须已存在于 Xero**：账单要带 `ContactID`，Demo Company 里没有你的供应商，第一次跑必撞 400。本项目目前**不会自动建联系人**，接真环境前要么手工在 Xero 里加，要么补一段「找不到 contact 就 `POST /Contacts` 自动建」的逻辑。
52. **Xero 开发者应用的 Redirect URI 要逐字匹配**：必须和 `config/default.json` 的 `xero.redirectUri`（`http://127.0.0.1:54545/callback`）完全一致——端口、结尾斜杠、大小写都不能差，差一个字 `xero auth --code=...` 就报 `invalid_client` / redirect_uri_mismatch。app 名不能含 "Xero" 字样，client secret 只显示一次。

53. **中文发票进 Xero 的税费/科目映射目前是空的，别直接推真环境**：`xero.defaultTaxCode = INPUT`、`defaultAccountCode = 600` 是新西兰 GST 的科目，中国 1% 增值税不能当 GST 输入税申报，CNY 也不是 Xero 账套的默认币种。现在 mock 阶段照单全收（`taxCode: INPUT` / `currency: CNY` 原样进草稿 JSON），真推之前必须补一张「币种 → 税码/科目」映射，否则建出来的草稿在 Xero 里是错的账。

## 8. 验收用例 → 自动化测试

| 验收要求（来自案例文档） | 断言位置 |
| --- | --- |
| 同一邮件重试不重复建单 | `同一封邮件反复扫描，只建一条草稿` + `重推已有发票不会重复建单` |
| 税额/总额不一致不许静默通过 | `金额自洽不过关的发票转人工，且不会建单` |
| 扫描件日期不确定要醒目标记 | `没有文本层的扫描件要求 OCR，不静默填数字` |
| 终态仍是草稿、无人越权批准 | `终态永远是草稿，不存在任何自动批准动作` |

跑法：`npm run fixtures && npm test`。

四条用例各自防什么事故（抄错数直接入账 / 一票变两单 / 黑盒硬填 / 越权批准）、断言落在哪一行、flag 字典与面板措辞，见 `ARCHITECTURE.md` §4。

## 9. 配置速查（`config/default.json`）

| 键 | 练手值 | 说明 |
| --- | --- | --- |
| `ingest.mode` | `both` | 收件双跑（邮箱 + `fixtures/inbox`）；`folder` 纯离线 / `imap` 只连邮箱 |
| `ingest.imap.idle` | `false` | 阶段一先关，跑稳了再开做秒级 |
| `ingest.pollIntervalMs` | `300000` | 5 分钟 |
| `filters.allowedSenderDomains` | `[]` | 正式跑前填 2~3 家供应商域名 |
| `xero.lineAmountTypes` | `Inclusive` | 供应商发票默认含税，别改 |
| `xero.defaultTaxCode` | `INPUT` | 新西兰组织用 INPUT，先 `GET` 拉税码表再确认 |
| `worker.concurrency` | `1` | 串行 |
| `review.autoCreateWhen` | `no-flags` | 有 flag 一律人工 |

## 9.5 阶段一跑法（已实现，可直接照抄）

```bash
npm run fixtures          # 造 4 封测试邮件到一个本地目录
npm test                  # 5 条用例全绿（typecheck 也过：npm run typecheck）
npm run demo              # 收件 → 人工确认门 → 串行处理 → 落一份草稿
node --import tsx src/cli.ts list          # 任务队列视角
node --import tsx src/cli.ts show 1        # 单条任务 + 事件流
node --import tsx src/cli.ts admit --all   # 把观察池整批纳入
node --import tsx src/cli.ts reconcile     # 模拟每日对账：全量重扫 + 打印被挡掉的邮件
```

`demo` 的输出形态（阶段一验收对得上）：

```
扫描 4 封：新入库 4，重复 0，被过滤 0
观察池 4 条，状态 observed（对应「待开票输入」面板，等人工确认）
人工确认纳入：4 条
  处理 1 条：建草稿 1，转人工 0，重试 0，死信 0，跳过 0
  处理 1 条：建草稿 0，转人工 1，重试 0，死信 0，跳过 0   # 扫描件（OCR_NEEDED）
  处理 1 条：建草稿 0，转人工 1，重试 0，死信 0，跳过 0   # 金额不自洽
  处理 1 条：建草稿 0，转人工 1，重试 0，死信 0，跳过 0   # 垃圾邮件
```

**阶段一已知限制（不是 bug，是范围）**，下一步真接到 Xero / 邮箱时要先补这些：

1. 解析层是纯正则 + 行坐标重建，只适配「文本层规整的 PDF」；版式一变必然降置信度，**这是预期行为，不是要立刻上 AI**。
2. 明细数量取行内第一个数字，认不出来记 `1`；多币种行、折扣行、多行税率行不会分。
3. OCR 只有开关，没有实现——扫描件一律 `OCR_NEEDED` 拦到人工（阶段一不引 OCR 依赖）。
4. 字段映射里的 `accountCode/taxCode` 目前是配置里的固定值（600/INPUT），真接不同组织时要按组织或费用代码查表，不能写死。
5. 收件层默认 `folder`；真实邮箱的跑通验证要你自己填 `FN_IMAP_USER/PASS` 后跑 `imap check`；`idle` 默认关。
6. 四个面板还在 CLI/事件表层面，没有 Electron IPC 消费者。

> 阶段二/三已按上表 4、5 补齐实现（详见 `ARCHITECTURE.md` §9）：`XeroApiAdapter` 支持 token 轮换、429/401 分类、附件二次上传、建单前查重；IMAP 层支持 UID 水位、增量窗口、断线重连与探活；真接口路径由 `scripts/fake-xero.mjs` + `test/xero.test.ts` 零凭证回归（6 组断言）。剩下没做的只剩「你的真凭证首次联调」与「IDLE 真实跑一周观察」。

## 10. 分阶段路线

1. **阶段一（现在）**：本地 folder 源 + mock Xero + 上表四面板的数据模型 + 四条验收用例全绿。完全不碰网络与 OAuth。
2. **阶段二**：换 `XeroApiAdapter`（OAuth2 + token 轮换 + tenantId），收件层一行不用改。
3. **阶段三**：`ingest.mode = imap`，开 IDLE + 25 分钟重连 + 轮询兜底，加每日对账。
4. **阶段四**：接 fetchnow-workflow 四个面板（IPC 消费 events 与 invoices）。
5. **阶段五**：扩到 #568 的 PO 匹配与异常工作台，届时再引入多角色与审计追溯。
54. **`filters.allowedSenderDomains` 一度是「死配置」**：类型里声明了，但 `src/ingest.ts` 从未读它，
    所以填了完全没反应。补上时又第一个版本写成 `allowed.includes(完整地址)`——而配置项按名字就该填**域名**
    （配 `vendor.com` 是想同时放行 `boss@vendor.com` / `ap@vendor.com`），于是「域名配了却一封都不放行」。
    现在 `senderAllowed()` 按域名比（`.vendor.com` 走子域精确匹配，防 `vendor.com.attacker.com` 绕过）。
55. **`invoices` 表原来没有 `from_addr` 列**：自动纳入要靠域名判断，没这一列就只能永远人工点。
    坑在于 `CREATE TABLE IF NOT EXISTS` **不会给老库补列**——git 里已存在的 `fetchnow.sqlite` 建表时没有
    `from_addr`，跑起来不报错，只是「白名单填了却不生效」，极难发现。所以 `open()` 里按
    `PRAGMA table_info` 查一次再 `ALTER TABLE ADD COLUMN`。
56. **`observed → admitted` 这条边有两个触发方，门禁必须画窄**：`admitInvoice`(人) 与 `autoAdmitTrusted`(机器)。
    后者只在 `review.autoAdmitDomains` 命中时调用，列表为空 = 永远等人点（默认）。别用 `["*"]` 之类的通配，
    那等于让任何人都能往这个收件箱塞 PDF 直接进自动建单链路。
57. **MIME 分隔行是 `--` + boundary，不是 boundary 本身**（造测试邮件时踩到）：boundary 名自带横杠时
    （比如 `_FN_boundary_x` 没事，写成 `----=_part_boundary` 时）分隔行会少一对横杠，
    mailparser 拆不开 multipart，**附件静默丢失**——`attachments` 是空数组，没有任何报错，
    表现是「这封邮件被当成没附件」直接过滤掉。排查方法：单独 `simpleParser` 一把那个 .eml 看 `attachments.length`。
58. **`npm run watch` 必须是单进程**：原来 `watch` = `scan --watch`，等于要求你开两个终端分别跑收件与处理，
    而且两条进程会各自 `open()` 同一份 sqlite 抢写。现在 `watch` 指向 `cli.ts watch`——
    一个 `runAutoCycle()` 里依次做 收件 → 白名单纳入 → 处理，`--once` 只跑一轮。
59. **`imap.idle` 曾经是个完全不生效的开关**：`ImapSession.idle()` 写了但**没有任何地方调用**，
    `imap.idle` / `imap.explicitIdle` 两个配置项也没人读。表现是最坑的那种——把开关拨到 true、什么都没发生、
    也不报错。教训：配置项要么被读，要么从类型里删掉（这次顺手删了 `explicitIdle`）。
60. **IMAP 的 IDLE 别自己实现，imapflow 2.x 自带**：已选中邮箱 + 连接空闲 15 秒后库自己发 IDLE（`autoIdleDelay`），
    空闲超 `maxIdleTime` 自己 DONE 再重进，正好绕开服务器约 29 分钟静默掐线。
    我们只需留着连接 + 听 `exists` 事件。相应地建连接时要传 `disableAutoIdle: !imap.idle`——
    不用 IDLE 时明确关掉，免得长连接在两次扫描之间偷偷进 IDLE 又被打断。
61. **手动 `client.idle()` + `Promise.race` 超时是错的**：`idle()` 要等这一轮 IDLE 结束才 resolve，
    race 一个 setTimeout 只是「我们不等了」，连接仍留在 IDLE 里，下一轮 select 还得先撬开它；
    而且每次 race 都留一个永不 resolve 的 promise。已删掉该方法，改成 `waitForPush(ms)`
    （听 `exists`/`close`，返回 pushed/timeout/dropped）。
62. **`waitForPush` 里的计时器不能 unref**：unref 的定时器不撑事件循环，外面没有别的 ref 句柄时
    进程会在等待中途排空退出，等待方**永远等不到 resolve**（不是超时，是永远）。
    进程存活与否交给外层循环定时器的 keepAlive 决定，这一层只管等待。
63. **`startAutoPipeline` 的循环定时器曾 unref，于是「常驻」是假的**：首轮跑完事件循环就空了，
    进程安静退出，而屏幕上还写着「后台扫描已启动，Ctrl+C 退出」。这也解释了之前 `npm run scan --watch`
    「只输出一行就回到提示符」——当时我归因于 npm 吃掉 `--watch`，那个原因确实也存在（要写 `-- --watch`），
    但真正让进程消失的是这个 unref。现在常驻一律 `keepAlive: true`，`unref` 只留给测试（避免吊住测试进程），
    并有测试断言「keepAlive 时挂着 ref 定时器、stop() 后消失」。
64. **IDLE 只盯被选中的邮箱**：IDLE 和 `search` 都作用在 `imap.mailbox`（默认 INBOX）。Gmail 的标签不是文件夹，
    过滤规则把发票邮件跳过收件箱直接归档到标签的话，它同时逃过 IDLE 和轮询，表现得像「什么都没收到」。
    要覆盖得把 `imap.mailbox` 改成 `[Gmail]/All Mail`（`imap check` 会列出可用邮箱），代价是扫描范围变大。
65. **退避停在 30 秒 = 自锁死**：`reconnectBackoffMs = [2000, 10000, 30000]` 跑满三档后**永远停在 30 秒**。
    原来只想着「凭证错时别 2 秒捶一次」，但 30 秒一次就足够触发服务端限流，而**每次都重试又在给惩罚续期**，
    于是账号永远恢复不了。退避阶梯必须排到**分钟级**（现在是 2s/10s/30s/2min/10min），
    「停手等它过期」才有机会发生。有回归测试卡住「最后一档 ≥ 5 分钟且单调不减」。
66. **`Client network socket disconnected before secure TLS connection was established` 是限流，不是密码错**：
    排查顺序（都是实测）——① 同一时刻 `openssl s_client` 能拿到证书链、`nc -vz` 通 → 不是网络；
    ② 错误出在**握手阶段**（`code=ECONNRESET`，栈在 `TLSSocket.onConnectEnd`），根本没走到 AUTH → 不是密码；
    ③ 同一进程连 5 轮，**第 1 轮成功、2~5 轮全挂**，换独立新进程也一样 → 是服务端在拒新连接；
    ④ 目标对照：`smtp.gmail.com:465` / `www.google.com:443` / `outlook.office365.com:993` 全通，
    **只有 `imap.gmail.com:993` 被 RST** → 就是 IMAP 服务的限流。
    ⑤ **不是账号级**：被重置的是 TLS 握手，而握手在认证**之前**——那一刻服务端还不知道你要登哪个账号，
    所以只可能按「出口 IP + 服务」记。用手机热点连一次就能验证这个区分。
    openssl 那次「成功」是假象，它的报错里跟着 `unexpected eof while reading`——握手刚完就被关，Node 只是死在握手中间。
    静默实测：停手 2.5 分钟、8 分钟均未恢复，**惩罚窗口在十分钟量级**——这也正是退避必须排到分钟级的原因。
    **遇到就该停手等**，别开第二个终端继续连；`explainImapError()` 现在会把这几类原因分开讲人话，`imap check` 也会打出来。
67. **建连失败时那条 client 没被关掉，还害得下一轮多连一次**：`ensureConnected()` 里 `this.client = client` 在
    `await client.connect()` 之后，所以连接失败时那条 ImapFlow 直接被丢掉——但它的 socket 和监听器还在
    （`lsof` 里能看到一条挂着的 `CLOSED` 连接），而且它的 `close` 事件会让 `waitForPush` 以为「连接断了」，
    下一轮就**再连一次**：重连次数翻倍，正好喂给限流。现在失败时显式 `close()` 并自己记 `pendingDrop`，
    同一轮里只允许一次连接尝试（有测试钉住）。
68. **「再测一遍」不能靠重发邮件**：同一张发票第二次收会被**两层**去重挡下——`messages` 按 messageId、
    `invoices` 按附件 sha256。只清一层会看到「扫描 N 封、新入库 0」，很像代码坏了，其实去重是对的。
    所以固化成 `npm run retest`：默认把最后一条已建单的票复位回 `observed` 再走「纳入 → 建草稿」；
    加 `--from-mail` 会连邮件记录一起清掉（`DELETE invoices` + `DELETE messages WHERE message_id=?`），
    让 scan 真的重收一遍，验的是完整链路。两条路径共用同一段收尾逻辑，别写两份。
    细节：复位时顺手删掉这张票上一次的草稿 json，否则每测一次多一个孤儿文件；
    位置参数只认纯数字，`'--from-mail'` 不能进 `Number()`（否则 NaN 会被当成「没给 id」）。
    提醒：`--from-mail` 若 `ingest.mode` 不是 `folder`，会去连一次邮箱——限流期间配 `FN_INGEST_MODE=folder`。
