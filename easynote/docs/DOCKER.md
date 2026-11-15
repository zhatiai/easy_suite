# 服务器与 Docker 部署

[English](DOCKER.en.md)

EasyNote 支持两种部署方式：原有 Cloudflare，以及独立 Linux 服务器上的 Docker。服务器运行不需要 Cloudflare 账号、Token、D1/R2 云资源或 Cloudflare 网络连接。构建镜像需要访问 npm 和镜像仓库。

## 兼容方案与边界

服务端仍运行同一份 `src/worker/index.ts`，前端、REST、MCP/OAuth、Schema、修订号、幂等、历史、墓碑、租户隔离和离线合并保持原有实现。

| 能力 | Cloudflare | Docker |
| --- | --- | --- |
| Worker API | 托管 Worker | 本地开源 workerd，由锁定版本的 Miniflare 托管 |
| D1 / FTS5 / batch 事务 | 托管 D1 | 持久化 SQLite 与相同的 D1 API |
| 图片及附件 | 私有 R2 | 本地持久化对象存储与相同的 R2 API |
| 用户变更通知 | Durable Object WebSocket | 本地持久化 Durable Object WebSocket |
| Cron 清理 | Cloudflare Cron | 宿主每小时 UTC 第 17 分钟调用相同 scheduled handler |
| 静态资源 / PWA | Assets | 相同 Vite 产物、SPA 回退与安全响应头 |

选择运行时兼容层，是为了避免重新实现 SQL 事务、R2 流和 WebSocket 语义。Miniflare 原本用于本地运行，它不提供托管平台的 SLA、跨机调度或高可用。本方案面向个人或小团队的单机、单副本部署；每个数据目录只允许一个服务实例，不能把同一个目录挂给多个副本，也不能作为多个主节点共享的 NFS 存储。扩容需要另行设计存储和事件分发。

所有权威数据在 `/data/state` 下，包含 `d1`、`r2`、`do`。运行时依赖版本被 npm lockfile 锁定，升级前必须冷备份。不要手改内部 SQLite 文件、对象存储布局或已应用的 migration。

## 首次部署

服务器需要 Docker Engine 和 Docker Compose v2。推荐 Linux amd64/arm64、持久化本地磁盘、有效域名及现有 HTTPS 反向代理。以下命令在 `easynote` 目录执行。

```bash
cp .env.docker.example .env
# 编辑 .env，设置 PUBLIC_ORIGIN=https://你的域名（末尾不带 /）
# 按需调整 EASYNOTE_DATA_DIR，以下示例使用默认目录。
sudo install -d -m 700 -o 10001 -g 10001 /var/lib/easynote/data
docker compose build
docker compose run --rm easynote node scripts/setup.mjs --docker
docker compose up -d --wait
docker compose logs --tail=100 easynote
```

初始化必须在终端交互输入账号和密码。仅保存加盐验证器 `/data/initial-owner.json`，不保存明文密码。重复执行初始化不会覆盖已有验证器，也不会重置数据库账号。容器固定以 UID/GID `10001:10001` 运行，数据目录必须允许此用户读写；不要通过运行 root 容器解决权限问题。

Compose 默认仅在宿主 `127.0.0.1:8791` 发布入口；健康端口只在容器环回地址监听，通过 Docker healthcheck 使用。首次启动完成 migration、账号引导和 Worker 探测后才开放入口。缺少管理员配置或 migration 失败时，启动失败。

构建可通过 `docker compose build --build-arg NODE_OPTIONS=--max-old-space-size=1536` 调整 Node 堆上限。构建期间还需要为 Node 原生内存和其他进程保留空间。Dockerfile 在生产依赖安装阶段复用构建阶段的 npm 缓存，缓存不进入运行镜像。

### 在构建机生成前端产物

服务器可用内存不足时，在开发机或 CI 使用相同版本源码执行 `npm ci --include=dev` 和 `npm run build`，将完整 `dist/` 目录传到服务器。然后使用预构建配置启动：

```bash
docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml build
docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml run --rm easynote node scripts/setup.mjs --docker
docker compose -f docker-compose.yml -f docker-compose.prebuilt.yml up -d --wait
```

默认从服务器项目目录只读挂载 `./dist`，也可在 `.env` 设置绝对路径 `EASYNOTE_DIST_DIR`。该配置使用 Dockerfile 的 `runtime` target。依赖安装和服务器运行在容器中，前端编译在构建机完成。升级时应停止服务，替换与服务端源码配套的完整 `dist/`，再重建并启动。

### HTTPS 反向代理

下面示例假设 Nginx 在同一宿主运行，已有域名证书。把域名和证书路径替换为实际值。`map` 放在 Nginx `http` 上下文中。

```nginx
map $http_upgrade $easynote_connection {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name notes.example.com;
    ssl_certificate /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:8791;
        proxy_http_version 1.1;
        proxy_set_header Host notes.example.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $easynote_connection;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

`PUBLIC_ORIGIN` 必须是浏览器实际使用的 HTTPS origin，包含非默认端口（如有），不能带路径、账号、查询或末尾斜杠。入口核对 Host，并用此配置构造 Worker URL，保证 Secure Cookie、CSRF、分享链接和 OAuth/MCP metadata 的域名一致。运行时的内部端点和 `MF-*` 控制头不会开放给客户端。

仅当入口受可信反向代理保护，且代理**覆盖** `X-Real-IP` 时设置 `TRUST_PROXY=true`。否则使用 `false`，所有请求按 socket 来源进行 IP 限流。不要把 8791 直接暴露公网；入口根据配置中的 HTTPS origin 处理内部 HTTP，TLS 必须由反向代理实际终止。

本机试运行可使用 `.env.docker.example` 末尾的 HTTP 环回配置。它使用开发 Cookie；手机、远程浏览器、PWA 和 MCP 的正式使用应通过 HTTPS。反向代理也在容器中时，用隔离的 Docker 网络连接 `easynote:8791`，仍须固定 Host 并覆盖 `X-Real-IP`。

## 配置

| 配置 | 默认 / 说明 |
| --- | --- |
| `PUBLIC_ORIGIN` | 必填，浏览器访问的 HTTPS origin |
| `EASYNOTE_DATA_DIR` | Compose 宿主路径，默认 `/var/lib/easynote/data` |
| `EASYNOTE_PORT` | 宿主环回端口，默认 `8791` |
| `TRUST_PROXY` | 默认 `false`，是否信任代理覆盖的 `X-Real-IP` |
| `ALLOW_LOCAL_HTTP` | 默认 `false`，仅配合 HTTP 环回 origin 使用 |
| `INITIAL_OWNER_FILE` | 容器内默认 `/data/initial-owner.json`，可指向只读 secret 文件 |

容量、版本保留、自动保存及限流默认值继续来自 `wrangler.json.vars`。需要修改时，在 Compose 的 `environment` 中显式添加相同名称的配置，例如 `MAX_NOTES: "10000"`；宿主环境不会自动传入容器。`.env`、数据目录和备份不能提交到 Git，也不会进入构建上下文。

## 从 Cloudflare 迁移

先将所有设备的离线草稿同步完成，在维护窗口停止源站写入。用**当前版本**的灾备命令生成包含账号、文件夹、笔记、历史、分享、令牌和附件的备份；参见[灾难恢复](DISASTER_RECOVERY.md)。旧版备份可能不含文件夹，校验会拒绝不完整 Schema。

在新服务器准备 `.env`、空数据目录及镜像后，挂载备份为只读。不要先启动服务，也不必新建管理员：

```bash
docker compose run --rm -v /absolute/path/to/backup:/backup:ro easynote \
  node scripts/server-import.mjs /backup --check
docker compose run --rm -v /absolute/path/to/backup:/backup:ro easynote \
  node scripts/server-import.mjs /backup
docker compose up -d --wait
```

导入检查 Schema 指纹、数据库和每个对象的 SHA-256。数据先写入私有暂存目录，通过外键检查并关闭数据库后才发布为 `state`；失败时删除暂存目录。目标已有 `state` 时拒绝导入，防止覆盖已有数据。只导入应用表，FTS 索引由原有触发器重建。

切换域名前检查登录、搜索、附件、历史、分享、MCP 和两浏览器实时同步。优先保留原域名；更换 origin 时浏览器的 Cookie、IndexedDB 草稿及 PWA 缓存不会跨域自动迁移，MCP 客户端地址也需要更新。OAuth 的临时授权码和进行中的 WebSocket 不迁移，客户端重连或重新授权即可。不要让新旧服务同时接收写入。

## 备份、恢复与升级

容器备份必须同时覆盖 D1、R2、DO，不能在服务写入时只复制 SQLite 文件。

```bash
# Linux 宿主执行。脚本确认挂载位置，停止容器，再归档 state、生成校验和并重启。
sudo bash scripts/backup.sh
# 自定义目录时同时传入 --data-dir 和 --backup-dir。
```

归档包含账号验证器、会话、正文和附件，须保存在受限目录并另存异机。脚本默认保留最近 7 份；Docker 不可用或挂载位置不匹配时拒绝备份。原有根目录 `backup.sh` / `restore.sh` 面向 Cloudflare/Wrangler，不用于恢复 Docker 内部状态。

冷备份恢复只针对停止的容器：先校验 `.sha256`，把归档的 `state/` 解压到一个**新的空数据目录**，设为 `10001:10001` 且限制目录权限，在 `.env` 指向该目录，再启动对应版本的镜像。先保留旧目录，完成登录、附件和同步检查后再处理旧数据。不要直接覆盖运行中的目录。恢复已有账号的数据不依赖初始验证器文件。

```bash
docker compose stop
# 执行冷备份并确认成功后，更新代码。
docker compose build
docker compose up -d --wait
```

升级自动应用未执行的 migration；每次 migration 与其记录在同一事务提交。失败时不接受请求。镜像回滚必须同时考虑 Schema：遇到未知或已修改的 migration 会拒绝启动，应恢复与旧镜像配套的整份冷备份，不能只回滚镜像。

## 验证

```bash
npm run check
npm run build
npm test
npm run test:scripts
npm run test:ui
bash deploy.sh --check
docker compose config --quiet
```

`test/server.test.mjs` 使用真实服务器进程和持久化目录，覆盖 HTTPS origin、安全头、CSRF、租户隔离、幂等、修订冲突、文件、FTS、分享、MCP、WebSocket、停机重启、migration 回滚及 scheduled 清理。`test/server-import.test.mjs` 检查完整备份导入、对象损坏和拒绝覆盖。它们不能代替目标 Linux 上的镜像构建与部署验收。
