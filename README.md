# Stockpulse Notes

Stockpulse 是一个单人使用的个人笔记网站。前端使用 React/Vite，后端使用 Express，笔记保存到服务器本地 `data/notes.json`。

## 本地开发

```bash
npm install
cp .env.example .env
npm run dev
```

默认访问 `http://localhost:5173`。API 服务运行在 `http://localhost:3000`。

## 生产构建

```bash
npm run typecheck
npm run build
npm start
```

## 环境变量

```bash
PORT=3000
NOTES_PASSWORD=your-private-password
SESSION_SECRET=your-long-random-secret
```

## 阿里云轻量服务器部署

以下步骤默认系统为 Ubuntu，域名为 `stockpulse.com.cn`。

1. 将域名 `A` 记录指向服务器公网 IP。
2. 安装基础依赖：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

3. 创建应用目录并上传代码到 `/opt/stockpulse`。
4. 创建生产环境变量：

```bash
cd /opt/stockpulse
cp .env.example .env
nano .env
```

5. 安装、构建并启动：

```bash
npm install
npm run build
pm2 start dist-server/server/index.js --name stockpulse --update-env
pm2 save
pm2 startup
```

6. 配置 Nginx：

```bash
sudo cp deploy/nginx.stockpulse.conf /etc/nginx/sites-available/stockpulse
sudo ln -s /etc/nginx/sites-available/stockpulse /etc/nginx/sites-enabled/stockpulse
sudo nginx -t
sudo systemctl reload nginx
```

7. 签发 HTTPS 证书：

```bash
sudo certbot --nginx -d stockpulse.com.cn -d www.stockpulse.com.cn
```

8. 验收：

```bash
curl https://stockpulse.com.cn/api/health
```

## 备份

可以用 `scripts/backup-notes.sh` 备份最近 30 天的笔记：

```bash
APP_DIR=/opt/stockpulse bash scripts/backup-notes.sh
```
