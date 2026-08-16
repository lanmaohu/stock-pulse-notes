# Stockpulse

Stockpulse 是一个单人使用的自媒体投资观点监控工具。V1 支持 B 站扫码绑定、博主订阅、每日采集和投资观点提取；抖音、小红书保留统一适配器，尚未开放真实采集。

根路径 `/` 直接展示公开工作台，媒体观点、博主、平台账号、采集记录、采集设置和相关 API 均无需登录即可访问。生产环境中的旧路径 `/app` 和 `/app/` 会永久重定向到 `/`。

旧笔记、聊天、每日总结和 B 站数据会原样保留。启动时会在事务中把旧 B 站视频与观点复制到通用内容模型，迁移可重复执行且不会删除旧表。

## 功能

- `最新观点`：按采集日期展示新内容，同时保留原始发布日期
- `博主管理`：按主页链接、UID 或名称搜索并确认订阅
- `平台账号`：通过 B 站 App 扫码绑定，Cookie 加密保存且不会返回前端
- `采集记录`：查看采集与 AI 分析的独立状态和具体错误
- `采集设置`：配置 Asia/Shanghai 每日执行时间和单个博主采集条数

新订阅会立即采集最近 5 条内容。之后由持久化任务队列顺序采集、去重并限制请求频率；服务重启后会恢复未完成任务。同一时刻只执行一个采集任务。

## 本地开发

要求 Node.js 20 或更高版本。

```bash
npm install
cp .env.example .env
openssl rand -base64 32
npm run dev
```

将 `openssl` 输出填入 `.env` 的 `PLATFORM_CREDENTIALS_KEY`。公开工作台为 `http://localhost:5173`，API 为 `http://localhost:3000`。

## 环境变量

```bash
PORT=3000
APP_PASSWORD=your-private-password
SESSION_SECRET=your-long-random-secret
PLATFORM_CREDENTIALS_KEY=base64-encoded-32-byte-key
WEBHOOK_TOKEN=your-long-random-webhook-token
AI_MODEL=deepseek-chat
DEEPSEEK_API_KEY=your-deepseek-api-key
BILIBILI_COLLECT_CRON_TIME=07:30
BILIBILI_COOKIE=
```

- `APP_PASSWORD` 仅供旧 `/api/login` 兼容接口使用；公开工作台不读取该密码。未配置时兼容旧的 `NOTES_PASSWORD`。
- `PLATFORM_CREDENTIALS_KEY` 必须是 32 字节 Base64 或 64 位十六进制字符串。生产环境必须单独生成，丢失后已绑定账号需要重新扫码。
- `SESSION_SECRET` 仅用于签名旧 `/api/login` 兼容接口生成的令牌。
- `BILIBILI_COLLECT_CRON_TIME` 只用于数据库首次初始化，之后在“采集设置”中修改。
- `BILIBILI_COOKIE` 仅作为旧版本兼容回退；正常使用应在“平台账号”页扫码绑定。
- 旧 `SUMMARY_CRON_TIME`、`BILIBILI_UP_MIDS` 和 `BILIBILI_BVIDS` 不再启动任务。

## 校验与构建

```bash
npm run typecheck
npm test
npm run build
npm start
```

## 主要 API

网站数据与操作 API 均公开访问。`/api/auth/*` 保留为无操作兼容接口，旧 `/api/login` 仍可生成兼容 Bearer Token；Hermes webhook 继续使用独立 Bearer Token，防止外部伪造消息。

```text
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/session
GET    /api/platform-accounts
POST   /api/platform-accounts/bilibili/qr
GET    /api/platform-accounts/bilibili/qr/:sessionId
GET    /api/creators/search?q=...
POST   /api/creators
GET    /api/content-insights
POST   /api/collection-runs
GET    /api/collection-runs/:id
GET    /api/collection-settings
PUT    /api/collection-settings
```

HTTP 412、博主不存在、字幕缺失和 AI 失败分别记录。没有字幕时只使用标题、简介和标签生成低置信度观点，不下载或保存原视频。

## 网站备案

公开工作台底部展示“仅供资料整理和学习参考，不构成投资建议”、网站服务备案号 `粤ICP备2026023302号-1`，并链接工信部备案系统。备案公开配置位于 `src/siteConfig.ts`。

公安联网备案尚未办理。取得真实编号后，同时配置 `publicSecurity.number`、`publicSecurity.recordCode` 和本地备案图标路径；三个字段不完整时页面不会显示公安备案入口。

## 生产部署

部署前先备份 SQLite，并确保 `.env` 已配置独立的 `PLATFORM_CREDENTIALS_KEY` 和 `WEBHOOK_TOKEN`；若仍使用旧 `/api/login`，还需配置 `APP_PASSWORD` 和 `SESSION_SECRET`：

```bash
cd /opt/stockpulse
mkdir -p backups
cp data/stockpulse.sqlite backups/stockpulse-pre-media-v1.sqlite
npm install
npm run build
pm2 reload stockpulse --update-env
```

代码同步时必须排除生产密钥和数据：

```bash
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude .env \
  --exclude data \
  --exclude backups \
  ./ admin@your-server:/opt/stockpulse/
```

上线后检查：

```bash
curl https://stockpulse.com.cn/api/health
curl -i https://stockpulse.com.cn/api/content-insights
curl -I https://stockpulse.com.cn/app
```

第二个请求应返回 `200`，第三个请求应返回指向 `/` 的 `301`。随后直接打开 `/`，检查备案与免责声明，再验证平台账号、订阅和采集。

## 兼容数据

旧笔记、聊天、总结、研究建议和 Hermes/Clawbot webhook 数据均保留；对应读取 API 暂时兼容一个版本，但新版页面不再展示，也不会继续执行旧每日总结任务。Webhook 地址仍为：

```text
POST /api/webhooks/hermes/messages
Authorization: Bearer $WEBHOOK_TOKEN
```

数据库默认位于 `data/stockpulse.sqlite`。`scripts/backup-notes.sh` 可用于日常备份。
