# Stockpulse

Stockpulse 是一个自托管的投资观点监控与个人持仓展示站。公开站只提供最新观点和个人持仓；博主、平台账号、采集任务、采集设置和持仓发布统一放在管理员后台。

## 页面地址

- `/`：最新观点，视频与文字按发布时间倒序混排
- `/portfolio`：公开持仓及查看密码解锁
- `/admin/login`：管理员登录
- `/admin/creators`：博主管理
- `/admin/accounts`：平台账号
- `/admin/runs`：采集记录
- `/admin/settings`：采集设置
- `/admin/portfolio`：持仓草稿与发布

公开页面不会读取管理数据。管理页面按栏目加载自身数据；管理员会话失效后统一返回登录页。

## 运行架构

```text
Browser -> Nginx -> Express API -> SQLite
                         |
                         +-> persistent collection queue
                                      |
                                      v
                              Collection Worker
                              Bilibili + DeepSeek
```

- API 只处理 HTTP 请求和任务入队。
- 单实例 Worker 每秒原子认领一个任务，使用租约和心跳防止多进程重复处理；过期租约可恢复。
- API 与 Worker 各自只维护一个 SQLite 连接，统一启用 WAL、外键和 5 秒写锁等待。
- 数据库迁移必须显式执行；API 和 Worker 启动时只校验当前迁移版本。
- 请求日志使用 JSON 和请求 ID，不记录 Cookie、密码、平台凭据、字幕或 AI 密钥。
- B 站、二维码和 DeepSeek 请求均有超时；网络、限流和服务端错误最多重试一次，认证与业务错误不盲目重试。

## 本地开发

要求 Node.js 22；版本记录在 `.nvmrc`。

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
SESSION_SECRET=replace-with-a-long-random-secret
PORTFOLIO_VIEW_PASSWORD=change-this-view-password
PORTFOLIO_ADMIN_PASSWORD=change-this-admin-password
PLATFORM_CREDENTIALS_KEY=replace-with-a-base64-encoded-32-byte-key
WEBHOOK_TOKEN=replace-with-a-long-random-webhook-token
AI_MODEL=deepseek-chat
DEEPSEEK_API_KEY=your-deepseek-api-key
BILIBILI_COLLECT_CRON_TIME=07:30
BILIBILI_COOKIE=
```

- `SESSION_SECRET` 签名 HttpOnly、SameSite=Strict 会话 Cookie。
- `PORTFOLIO_VIEW_PASSWORD` 只解锁持仓敏感字段。
- `PORTFOLIO_ADMIN_PASSWORD` 同时用于工作台和持仓管理；管理员自动拥有查看权限。
- 会话令牌绑定对应密码版本，密码改变后旧会话立即失效。
- 登录失败次数保存在 SQLite；同一 IP 15 分钟最多失败 5 次。
- `PLATFORM_CREDENTIALS_KEY` 必须是 32 字节 Base64 或 64 位十六进制字符串。
- `BILIBILI_COLLECT_CRON_TIME` 只用于首次初始化，之后由管理后台设置。
- `BILIBILI_COOKIE` 仅作旧部署回退，正常使用扫码保存的加密凭据。

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
```

## API 边界

公开接口：

```text
GET    /api/health
GET    /api/content-insights
GET    /api/content-creators
GET    /api/portfolio
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
POST   /api/platform-accounts/bilibili/qr
GET    /api/creators
POST   /api/creators
POST   /api/collection-runs
GET    /api/collection-runs
GET    /api/collection-settings
PUT    /api/collection-settings
GET    /api/portfolio/admin/draft
PUT    /api/portfolio/admin/draft
POST   /api/portfolio/admin/publish
```

未登录访问管理接口返回 `401`，仅持仓查看者返回 `403`。所有错误响应都包含 `error`、稳定 `code` 和 `requestId`。Hermes 仅保留写入 webhook，并继续使用独立 Bearer Token：

```text
POST /api/webhooks/hermes/messages
Authorization: Bearer $WEBHOOK_TOKEN
```

旧 `/api/login`、笔记 CRUD、聊天查询、每日总结、AI 总结、研究建议和旧 B 站读取接口均返回 `404`。历史表和历史记录原样保留。

## 数据语义

观点接口按 `publishedAt DESC, collectedAt DESC, id DESC` 稳定排序。发布日期按 Asia/Shanghai 过滤，`pageSize` 只支持 `10`、`20`、`50`；响应包括当前页 `insights`、全量筛选统计 `summary` 和 `pagination`。旧 `collectedDate` 参数仍兼容，存在 `publishedDate` 时优先使用发布时间。

持仓快照、历史版本和公开字段裁剪均由服务端处理。未解锁响应不会包含股数、成本、绝对金额或股数变化。

## 生产部署

生产环境固定使用 Node.js 22、SQLite、Nginx 和 PM2。`deploy/ecosystem.config.cjs` 定义 `stockpulse` API 与单实例 `stockpulse-worker`。

每次部署按以下顺序执行：

1. 备份 SQLite 和环境配置，并记录核心表数据量。
2. 安装依赖并执行 `npm run migrate`。
3. 执行 `npm run typecheck`、`npm test`、`npm run build`。
4. 使用 `pm2 startOrReload deploy/ecosystem.config.cjs --update-env`。
5. 验证健康检查、公开脱敏、管理员鉴权、任务认领和 Worker 日志。

重构采用两阶段发布：第一阶段只同步服务端、共享类型和 Worker，保留当前生产前端；确认至少一次定时采集成功后，再同步新的 `dist` 前端和 Nginx `/app` 重定向。任何阶段异常都可回滚代码与 PM2 配置，无需删除或回退数据。

同步代码时必须排除 `.env`、`data`、`backups`、`node_modules` 和 `.git`。数据库变更只新增表、列或索引。

## 备案

页面底部展示投资风险提示和 `粤ICP备2026023302号-1`。备案配置位于 `src/siteConfig.ts`。
