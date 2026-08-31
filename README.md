# Stockpulse

Stockpulse 是一个自托管的投资观点监控与个人持仓管理站。公开站只提供最新观点；个人持仓、博主、平台账号、采集任务、采集设置和持仓发布仅对管理员开放。

## 页面地址

- `/`：最新观点，视频与文字按发布时间倒序混排
- `/portfolio`：管理员个人持仓全景图
- `/admin/login`：管理员登录
- `/admin/creators`：博主管理
- `/admin/accounts`：平台账号
- `/admin/runs`：采集记录
- `/admin/settings`：采集设置
- `/admin/portfolio`：持仓草稿与发布

公开页面不会读取管理数据。个人持仓和管理页面按栏目加载自身数据；管理员会话失效后统一返回登录页。

## 运行架构

```text
Browser -> Nginx -> Express API -> SQLite
                         |
                         +-> persistent collection queue
                                      |
                                      v
                              Collection Worker
                    Bilibili + Douyin + Xiaohongshu + DeepSeek
```

- API 只处理 HTTP 请求和任务入队。
- 单实例 Worker 每秒原子认领一个任务，使用租约和心跳防止多进程重复处理；过期租约可恢复，并每日生成可验证的 SQLite 备份。
- API 与 Worker 各自只维护一个 SQLite 连接，统一启用 WAL、外键和 5 秒写锁等待。
- 数据库迁移必须显式执行；API 和 Worker 启动时只校验当前迁移版本。
- 请求日志使用 JSON 和请求 ID，不记录 Cookie、密码、平台凭据、字幕或 AI 密钥。
- B 站和二维码请求均有超时并对瞬时错误最多重试一次；DeepSeek 每次内容分析只发送一个请求，失败后由后续采集重新尝试。

## 本地开发

要求 Node.js 22.16 或更高的 Node 22 版本；版本记录在 `.nvmrc`。

```bash
npm install
cp .env.example .env
npm run migrate
npm run dev
```

`npm run dev` 会先执行迁移，再并行启动 API、Worker 和 Vite。公开站默认位于 `http://localhost:5173`，API 位于 `http://localhost:3000`。

## 环境变量

```bash
PORT=3000
STOCKPULSE_DB_PATH=data/stockpulse.sqlite
STOCKPULSE_BACKUP_DIR=backups
BACKUP_LOCAL_TIME=03:15
BACKUP_RETENTION_DAYS=30
BACKUP_MINIMUM_COUNT=7
SESSION_SECRET=replace-with-a-long-random-secret
PORTFOLIO_VIEW_PASSWORD=change-this-view-password
PORTFOLIO_ADMIN_PASSWORD=change-this-admin-password
PLATFORM_CREDENTIALS_KEY=replace-with-a-base64-encoded-32-byte-key
WEBHOOK_TOKEN=replace-with-a-long-random-webhook-token
DEEPSEEK_API_KEY=your-deepseek-api-key
BILIBILI_COLLECT_CRON_TIME=07:30
BILIBILI_COOKIE=
PLATFORM_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
PLATFORM_BROWSER_HEADLESS=false
PLATFORM_BROWSER_DISPLAY=:99
# 可选：单一平台浏览器代理（凭据不要写进 URL）
PLATFORM_BROWSER_PROXY_SERVER=
PLATFORM_BROWSER_PROXY_USERNAME=
PLATFORM_BROWSER_PROXY_PASSWORD=
```

- `SESSION_SECRET` 签名 HttpOnly、SameSite=Strict 会话 Cookie。
- `PORTFOLIO_VIEW_PASSWORD` 只解锁持仓敏感字段。
- `PORTFOLIO_ADMIN_PASSWORD` 同时用于工作台和持仓管理；管理员自动拥有查看权限。
- 会话令牌绑定对应密码版本，密码改变后旧会话立即失效。
- 登录失败次数保存在 SQLite；同一 IP 15 分钟最多失败 5 次。
- `PLATFORM_CREDENTIALS_KEY` 必须是 32 字节 Base64 或 64 位十六进制字符串。
- DeepSeek 模型在管理后台“采集设置”中选择，支持 `deepseek-v4-flash` 和 `deepseek-v4-pro`；默认使用 Pro。切换只影响尚未开始或未成功的后续分析，不会重跑已经成功的历史内容。
- 真实视频字幕的分段摘要与投资观点由同一次 DeepSeek 请求生成。每段摘要附带经服务端校验的字幕原句，可在页面折叠查看；正文和仅元数据内容不生成摘要。
- 摘要功能只作用于新内容和后续重试内容，部署时不会批量补跑已经分析成功的历史视频。
- `DEEPSEEK_API_KEY` 供两个模型共用；旧部署中残留的 `AI_MODEL` 会被忽略。
- 每日备份默认在 Asia/Shanghai 03:15 执行，保留 30 天且至少保留最近 7 份。
- `BILIBILI_COLLECT_CRON_TIME` 只用于首次初始化，之后由管理后台设置。
- `BILIBILI_COOKIE` 仅作旧部署回退，正常使用扫码保存的加密凭据。
- `PLATFORM_BROWSER_EXECUTABLE_PATH` 指向可执行的 Chromium；抖音和小红书使用真实网页会话生成动态签名。
- 生产环境建议设置 `PLATFORM_BROWSER_HEADLESS=false`，由 PM2 管理的 Xvfb 在 `PLATFORM_BROWSER_DISPLAY` 上提供虚拟显示，避免登录页拒绝无头浏览器。
- 如果平台明确限制服务器出口 IP，可配置一个固定的 `PLATFORM_BROWSER_PROXY_SERVER`；这是单一出口设置，不包含代理池或验证码处理。

## 命令

```bash
npm run migrate       # 显式执行幂等迁移
npm run dev:api       # 开发 API
npm run dev:worker    # 开发 Worker
npm run typecheck
npm test              # 服务端与前端测试
npm run build         # 编译 API/Worker 并构建前端
npm run start:api
npm run start:worker
npm run ops -- doctor
npm run ops -- backup --reason manual
```

## API 边界

公开接口：

```text
GET    /api/health
GET    /api/health/live
GET    /api/health/ready
GET    /api/content-insights
GET    /api/content-creators
GET    /api/portfolio/session
POST   /api/portfolio/session
DELETE /api/portfolio/session
```

管理员会话：

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/session
GET    /api/platform-accounts
POST   /api/platform-accounts/:platform/qr
GET    /api/platform-accounts/:platform/qr/:sessionId
DELETE /api/platform-accounts/:platform/qr/:sessionId
GET    /api/creators
POST   /api/creators
POST   /api/collection-runs
GET    /api/collection-runs
GET    /api/collection-settings
PUT    /api/collection-settings
GET    /api/portfolio
GET    /api/portfolio/admin/draft
PUT    /api/portfolio/admin/draft
POST   /api/portfolio/admin/publish
```

未登录访问管理接口或持仓数据返回 `401`，仅持仓查看者返回 `403`。所有错误响应都包含 `error`、稳定 `code` 和 `requestId`。Hermes 仅保留写入 webhook，并继续使用独立 Bearer Token：

```text
POST /api/webhooks/hermes/messages
Authorization: Bearer $WEBHOOK_TOKEN
```

旧 `/api/login`、笔记 CRUD、聊天查询、每日总结、AI 总结、研究建议和旧 B 站读取接口均返回 `404`。旧业务表仅在已验证迁移备份中保留；Hermes 仍使用的 `chat_messages` 不删除。

## 数据语义

观点接口按 `publishedAt DESC, collectedAt DESC, id DESC` 稳定排序。发布日期按 Asia/Shanghai 过滤，`pageSize` 只支持 `10`、`20`、`50`；响应包括当前页 `insights`、全量筛选统计 `summary` 和 `pagination`。旧 `collectedDate` 参数仍兼容，存在 `publishedDate` 时优先使用发布时间。

持仓快照、历史版本和公开字段裁剪均由服务端处理。未解锁响应不会包含股数、成本、绝对金额或股数变化。

## 生产部署

生产环境固定使用 Node.js 22.16+、SQLite、Nginx 和 PM2。发布使用版本目录和原子软链接，本地执行：

```bash
DEPLOY_TARGET=user@server npm run deploy:prod
```

命令会上传当前 Git commit，在停机前完成依赖安装、测试和构建，然后备份、迁移、切换版本、重载 PM2 并自动验收。失败时恢复上一版代码，不自动回退数据库。

首次安装、Nginx/PM2 配置、日常检查、备份恢复、回滚和故障处理统一见 [运维手册](docs/operations.md)。

## 备案

页面底部展示投资风险提示和 `粤ICP备2026023302号-1`。备案配置位于 `src/siteConfig.ts`。
