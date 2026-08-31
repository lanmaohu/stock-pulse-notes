# Stockpulse 运维手册

本文是单机生产环境的唯一运维入口。生产架构固定为 Linux、Nginx、PM2、Node.js 22 和 SQLite，不需要 Docker 或外部监控平台。

## 1. 目录与前置条件

生产目录：

```text
/opt/stockpulse/
├── .env                         # 共享配置，权限 600
├── data/stockpulse.sqlite       # 共享数据库
├── backups/<backup-id>/         # 数据库、环境副本和 manifest
├── releases/<release-id>/       # 每次上传的完整源码和构建结果
├── current -> releases/...      # 当前版本
└── previous -> releases/...     # 上一版本
```

服务器必须安装：

- Node.js `>=22.16 <23`、npm；
- Chromium 与 Xvfb（Ubuntu/Debian 通常可安装 `chromium xvfb`，Alibaba Cloud Linux 可安装 `xorg-x11-server-Xvfb xorg-x11-xauth`），并在 `.env` 中将 `PLATFORM_BROWSER_EXECUTABLE_PATH` 指向实际可执行文件；
- PM2、Nginx、curl、rsync；
- Linux `flock`（通常由 `util-linux` 提供）。

PM2 命令必须始终由同一个 Unix 用户执行，否则会操作不同的 PM2 daemon。应用目录及共享数据也应属于该用户。

首次准备：

```bash
sudo mkdir -p /opt/stockpulse/{data,backups,releases}
sudo chown -R "$USER":"$USER" /opt/stockpulse
chmod 700 /opt/stockpulse/backups
cp .env.example /opt/stockpulse/.env
chmod 600 /opt/stockpulse/.env
```

编辑 `/opt/stockpulse/.env`，确保所有占位秘密均已替换。`PLATFORM_CREDENTIALS_KEY` 一旦用于加密平台凭据，不得随意更换；更换后必须重新绑定所有平台账号。

抖音、小红书采集会短时启动虚拟显示中的 Chromium。生产环境设置 `PLATFORM_BROWSER_HEADLESS=false`、`PLATFORM_BROWSER_DISPLAY=:99`；PM2 会维护 `stockpulse-xvfb`，发布脚本会在停服前检查 Chromium 与 Xvfb，`doctor` 会验证显示套接字。建议至少预留 1 GB 可用内存。

服务器出口 IP 被平台明确限制时，可选配置一个固定代理：

```bash
PLATFORM_BROWSER_PROXY_SERVER=http://proxy.example:8080
PLATFORM_BROWSER_PROXY_USERNAME=collector
PLATFORM_BROWSER_PROXY_PASSWORD=replace-with-secret
```

代理凭据不得嵌入 URL，也不得写入日志。该配置只提供单一浏览器出口，不实现代理池或验证码自动处理。

Twitter/X 使用官方开发者应用，不经过 Chromium。在 X Developer Console 创建 OAuth 2.0 Web App，启用只读权限并配置：

```bash
TWITTER_CLIENT_ID=replace-with-x-client-id
TWITTER_CLIENT_SECRET=replace-with-x-client-secret
TWITTER_OAUTH_CALLBACK_URL=https://stockpulse.com.cn/api/platform-oauth/twitter/callback
```

回调地址必须与 X Developer Console 完全一致。应用只申请 `tweet.read users.read offline.access`；X API 需要账户内有可用读取额度，具体费用由 X Developer Console 结算。Client Secret、访问令牌和刷新令牌不得写入日志或聊天。

在第一次发布成功、`/opt/stockpulse/current` 已存在后安装 Nginx 配置：

```bash
sudo cp /opt/stockpulse/current/deploy/nginx.stockpulse.conf /etc/nginx/conf.d/stockpulse.conf
sudo nginx -t
sudo systemctl reload nginx
```

启用 PM2 开机自启：

```bash
pm2 save
pm2 startup
```

执行 `pm2 startup` 输出的那条 `sudo` 命令，然后再次执行 `pm2 save`。

## 2. 一键发布

发布只接受已提交且工作区干净的 Git commit。先在本地验证目标和 release ID，不会连接服务器：

```bash
DEPLOY_TARGET=user@server npm run deploy:prod -- --dry-run
```

正式发布：

```bash
DEPLOY_TARGET=user@server npm run deploy:prod
```

自定义应用根目录时，本地和远端使用同一个变量：

```bash
DEPLOY_TARGET=user@server STOCKPULSE_APP_ROOT=/opt/stockpulse npm run deploy:prod
```

发布顺序固定为：上传新 release；安装依赖；执行 typecheck、全部测试和构建；停止 Worker 与 API；生成经校验的数据库和 `.env` 备份；执行迁移；原子切换 `current`；启动 PM2；等待 readiness；检查公开接口和匿名管理鉴权；保存 PM2 状态。

构建前失败不会影响线上。停机后失败会自动恢复 `previous`；首次采用版本目录时若尚无 `previous`，会重启 PM2 原有进程。任何失败都不会自动恢复数据库，已创建的备份会保留。

发布后检查：

```bash
ssh user@server '/opt/stockpulse/current/deploy/stockpulse.sh status'
ssh user@server 'pm2 logs stockpulse --lines 100 --nostream'
ssh user@server 'pm2 logs stockpulse-worker --lines 100 --nostream'
```

管理后台手工触发一次采集，确认任务最终为 `success` 或可解释的 `partial`，并检查 AI 日志中的模型与“采集设置”当前选择一致。

### 平台账号接入验收

首次启用或调整抖音、小红书登录逻辑后，使用管理员账号完成以下小流量验收：

1. 打开 `/admin/accounts`，分别生成小红书和抖音二维码；确认界面依次显示“等待扫码”“已扫码，请在手机确认”“已绑定”。
2. 扫码后核对页面展示的昵称和平台用户 ID，再点击“检查”，状态应保持“已连接”。遇到滑块、短信或其他安全验证时在平台要求的页面人工完成，不启用自动绕过。
3. 每个平台添加一个公开博主，并在“采集设置”中将每个博主检查数量暂时设为 `5`；各手工执行一次采集，确认任务完成且内容可在公开观点页读取。
4. 依次重启 `stockpulse` 和 `stockpulse-worker`，再次执行账号检查与单博主采集，确认 SQLite 中保存的加密登录态在进程重启后仍可用。
5. 关闭一个未扫码的二维码弹窗并立即重新生成，确认旧会话已取消；等待一个二维码自然过期，确认过期会话不能继续确认。
6. 查看最近日志和 `GET /api/platform-accounts` 的响应，确认其中没有 Cookie、浏览器 `storageState`、二维码图片或 `credentialsCiphertext`。二维码及平台账号响应必须带有 `Cache-Control: no-store`。
7. 完成验收后再恢复正式的采集数量和每日定时任务。若平台账号提示“需要重新登录”，只需重新扫码绑定；已采集内容与博主订阅不会被删除。

每个平台只保留一个管理员采集账号。重新绑定会更新原记录，不会创建第二个同平台账号。`PLATFORM_CREDENTIALS_KEY` 必须跨发布、API 重启和 Worker 重启保持不变，否则所有已保存登录态都需要重新绑定。

## 3. 健康检查与诊断

```bash
curl -fsS http://127.0.0.1:3000/api/health/live
curl -fsS http://127.0.0.1:3000/api/health/ready
cd /opt/stockpulse/current
npm run ops -- doctor
```

- `/api/health` 保留原有数据库连通性语义。
- `/api/health/live` 只证明 API 进程可响应，不依赖 Worker 或备份。
- `/api/health/ready` 同时检查数据库、迁移、Worker 心跳和最近 36 小时备份。
- Worker 超过 90 秒没有 ready 心跳时为 `stale`。
- `doctor` 还检查 Node 版本、配置、磁盘、过期租约和超过 15 分钟的排队任务；返回非零退出码表示需要处理。

所有应用日志均为单行 JSON，至少包含 `timestamp`、`level`、`service`、`release` 和 `event`。查询错误：

```bash
pm2 logs stockpulse --err --lines 200 --nostream
pm2 logs stockpulse-worker --err --lines 200 --nostream
```

日志不得出现 Cookie、密码、API key、字幕或 AI prompt；排查请求时使用 `requestId` 关联 `http_request` 与 `request_failed`。

## 4. 备份与异机复制

Worker 每天 Asia/Shanghai 03:15 自动备份。默认保留 30 天，同时至少保留最近 7 份。每份目录包含：

- `stockpulse.sqlite`：SQLite backup API 生成的一致快照；
- `environment.env`：权限 600 的部署配置副本；
- `manifest.json`：SHA-256、文件大小、迁移、表计数和 `quick_check` 结果，不含秘密值。

手工备份与校验：

```bash
cd /opt/stockpulse/current
npm run ops -- backup --reason manual-before-change
npm run ops -- verify-backup <backup-id>
```

不要用 `cp stockpulse.sqlite` 代替运维命令；数据库启用 WAL 时，单独复制主文件可能缺失已提交数据。

本机备份无法防止整台服务器或磁盘丢失。可从另一台机器定期拉取，不要在命令中加入 `--delete`：

```bash
rsync -az user@server:/opt/stockpulse/backups/ /secure/offsite/stockpulse/
```

至少每月随机选择一份异机备份执行 `verify-backup` 或在隔离目录完成恢复演练。

## 5. 代码回滚

代码回滚不会修改数据库：

```bash
ssh user@server 'STOCKPULSE_APP_ROOT=/opt/stockpulse /opt/stockpulse/current/deploy/stockpulse.sh rollback'
```

脚本交换 `current` 与 `previous`，重载两个 PM2 进程并重新执行 readiness 和 smoke test。新增迁移均按向前兼容设计，所以普通发布失败只回滚代码。

如果上一版代码确实依赖已删除的 legacy 表，不能只做代码回滚；必须进入维护窗口并按下一节恢复迁移前数据库。

## 6. 数据库恢复

恢复会覆盖当前数据库，必须确认目标 backup ID，并先停止两个进程：

```bash
cd /opt/stockpulse/current
npm run ops -- verify-backup <backup-id>
pm2 stop stockpulse-worker
pm2 stop stockpulse
npm run ops -- restore <backup-id> --confirm=RESTORE
npm run migrate
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
curl -fsS http://127.0.0.1:3000/api/health/ready
pm2 save
```

恢复命令检测到任一 PM2 进程仍在运行时会拒绝执行。覆盖前会自动创建 `pre-restore-*` 恢复点，并把旧 WAL/SHM 文件移入该恢复点。

上述流程会用当前代码重新执行迁移。若目的是临时运行依赖 legacy 表的旧代码，应恢复迁移前备份后直接切换对应旧 release，不要执行当前版本的 `npm run migrate`。

默认不恢复 `.env`。确需恢复时，先另存当前配置，复制备份中的 `environment.env`，设置权限 600，再重启；完成后必须验证所有登录和平台凭据。

## 7. 常见故障

### readiness 返回 503

先运行 `npm run ops -- doctor` 查看具体 check。`database` 或 `schema` 错误时不要反复重启，先确认磁盘空间和迁移日志；`worker=stale` 时查看 `stockpulse-worker` 错误日志；`backup=stale` 时手工执行一次备份。

### Worker stale 或队列积压

```bash
pm2 describe stockpulse-worker
pm2 logs stockpulse-worker --lines 200 --nostream
npm run ops -- doctor
pm2 restart stockpulse-worker --update-env
```

Worker 正常退出会释放当前租约，未完成 item 回到 queued。不要直接在 SQLite 中手工改任务状态。

### DeepSeek 失败

- `configuration`：检查 `DEEPSEEK_API_KEY`，并确认“采集设置”中的模型为 `deepseek-v4-flash` 或 `deepseek-v4-pro`；
- `authentication`：密钥无效，不会自动重试；
- `rate_limited`：等待配额恢复后由后续采集重新尝试；
- `timeout`、`upstream`：为保证每次分析只调用一次模型，本次任务不会再次请求；持续发生时查看 DeepSeek 状态；
- `invalid_response`：JSON、摘要结构或原文依据本地校验失败；系统不会调用模型修复，可由后续采集重新尝试。

日志只包含 content ID、模型、耗时、token、摘要段落数、观点数和错误码，不应粘贴字幕或密钥排查。

模型设置统一用于字幕、正文和仅元数据的观点提取。切换后只影响尚未开始或未成功的后续分析；已经成功的历史内容不会自动重跑。旧部署中残留的 `AI_MODEL` 环境变量会被忽略。

视频字幕摘要与观点在同一次 DeepSeek 请求中生成，每次分析尝试最多请求一次。摘要只覆盖真实字幕，并逐段保存可核验的字幕原句；正文、元数据和历史成功内容不会生成或自动补齐摘要。

### B 站账号失效

后台平台账号显示 `needs_reauth` 或认证错误时，重新扫码绑定。不要把 Cookie 写入日志或聊天；`.env` 中的 `BILIBILI_COOKIE` 只作为旧部署应急回退。

### 抖音或小红书账号失效、触发风控

后台显示 `needs_reauth` 时重新扫码绑定。出现安全验证或访问频繁时，不要连续重试；先确认 `doctor` 的浏览器模式为 `virtual-display`。若平台仍明确拒绝服务器出口 IP，等待风控解除或配置一个经过授权的固定代理后再检查。Chromium、Cookie、storage state、二维码令牌、代理密码和采集正文都不得写入日志或聊天。

### Twitter/X 授权或采集失败

- 后台提示未配置：检查三个 `TWITTER_*` 变量以及 X Developer Console 的回调地址；
- 授权无效：在平台账号页点击“重新授权”；刷新令牌会自动续期并重新加密保存；
- 读取额度不足：在 X Developer Console 补充 API credits，避免连续重试；
- 受保护账号：系统只采集公开内容，不支持订阅受保护账号；
- 解绑只删除本系统内的加密凭据；需要彻底撤销时同时在 X 的已授权应用页面撤销访问。

### SQLite locked、损坏或磁盘不足

先停止新发布和手工采集，运行 `doctor` 与备份校验。锁定持续超过 5 秒时检查是否启动了多个 Worker 或多个 PM2 用户。`quick_check` 失败时停止 API/Worker，选择最近通过校验的备份恢复。磁盘不足时优先将已验证的旧备份复制到异机，再删除不受保留策略保护的旧 release；不要删除 `data`、`current`、`previous` 或最近 7 份备份。

## 8. 安全与月度检查

每月执行：

1. `npm run ops -- doctor`；
2. 检查最近一次定时采集和每日备份；
3. 校验一份本机备份和一份异机副本；
4. 检查磁盘、PM2 开机自启和 Nginx 配置；
5. 抽查日志没有秘密或字幕；
6. 确认管理员密码、Webhook token 和 DeepSeek key 的保管人。

轮换 `SESSION_SECRET` 或管理员密码会使现有会话失效。轮换 `WEBHOOK_TOKEN` 需要同步 Hermes。轮换 `PLATFORM_CREDENTIALS_KEY` 会使既有加密凭据无法解密，必须先规划重新绑定平台账号。
