# ==========================================
# 阶段 1: 生产产物构建 (Builder)
# ==========================================
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ARG NODE_OPTIONS

# 利用缓存层安装锁定依赖
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# 复制源码并构建前端与 Worker Bundle
FROM dependencies AS builder
COPY . .
RUN npm run build

# ==========================================
# 阶段 2: 极简生产运行镜像 (Runner)
# ==========================================
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8791
ENV HEALTH_PORT=8792
ENV DATA_DIR=/data

# 创建专用非特权运行用户
RUN groupadd -g 10001 easynote && \
    useradd -u 10001 -g easynote -m -s /bin/bash easynote

# 安装仅包含生产必需的锁定依赖
COPY package.json package-lock.json ./
RUN --mount=type=bind,from=dependencies,source=/root/.npm,target=/root/.npm,rw \
    npm ci --omit=dev --no-audit --no-fund

# 提取构建产物与配置
COPY migrations ./migrations
COPY scripts/server.mjs scripts/setup.mjs scripts/server-import.mjs scripts/maintenance.mjs ./scripts/
COPY wrangler.json ./wrangler.json

# 建立数据挂载点并授权
RUN mkdir -p /data/state /data/backups && \
    chown -R easynote:easynote /data

USER easynote:easynote
EXPOSE 8791
VOLUME ["/data"]

# 生产探针直接调用独立的 8792 健康检查端口
HEALTHCHECK --interval=20s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8792/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "scripts/server.mjs"]

FROM runtime AS runner
COPY --from=builder /app/dist ./dist
