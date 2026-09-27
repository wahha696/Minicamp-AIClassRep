# ClassRep 后端镜像（问题 4：Docker Compose 部署模板）。
# 容器里不跑 QQ 注入（那是 Windows 专属）：通过 ONEBOT_WS_URL 连外部 NapCat 的
# OneBot WebSocket（官方 NapCat.Shell 或 napcat 容器），事件照收，功能一致。
# 数据库/配置都在 /app/data（按账号分库：data/accounts/<uin>/classrep.db），挂 volume 即可持久化。
# 构建与运行：见 docker-compose.yml 或仓库 README「Docker 部署」。
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable
# 先拷 manifest 装依赖（利用层缓存，源码变了不用重装依赖）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile
# 再拷源码并构建（server=esbuild 单文件，web=vite 静态产物）
COPY apps/ apps/
RUN pnpm --filter server build && pnpm --filter web build

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# 与打包布局一致的运行时文件：server 单文件 bundle + web 静态产物
COPY --from=build /app/apps/server/dist/index.js ./app/server/dist/index.js
COPY --from=build /app/apps/web/dist ./app/web/dist
# 打包布局标记（app/web/dist 存在 → 后端按打包版跑：自动开浏览器的 exec 会静默失败，无碍）
COPY --from=build /app/package.json ./app/package.json
EXPOSE 8000
VOLUME ["/app/data"]
# ONEBOT_WS_URL 在 docker-compose.yml 里给（默认 ws://napcat:3001）
CMD ["node", "app/server/dist/index.js"]
