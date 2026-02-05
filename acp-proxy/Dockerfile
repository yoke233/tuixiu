FROM node:20-slim AS build

RUN sed -i 's@deb.debian.org@mirrors.aliyun.com@g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY acp-proxy/package.json acp-proxy/tsconfig.json ./acp-proxy/

RUN corepack enable
RUN --mount=type=cache,target=/root/.cache/pnpm \
  pnpm install --filter ./acp-proxy... --frozen-lockfile

COPY acp-proxy ./acp-proxy
RUN pnpm -C acp-proxy build

FROM node:20-slim

RUN sed -i 's@deb.debian.org@mirrors.aliyun.com@g' /etc/apt/sources.list.d/debian.sources
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  ssh \
  git \
  ripgrep \
  bubblewrap \
  uidmap \
  && rm -rf /var/lib/apt/lists/*

# bwrap 在 ro-bind / 的模式下，要求目标挂载点（如 /workspace）在只读根里已存在，
# 否则会尝试 mkdir 并因只读文件系统失败。
RUN mkdir -p /workspace

WORKDIR /app

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/acp-proxy /app/acp-proxy

WORKDIR /app/acp-proxy

ENV PNPM_REGISTRY=https://registry.npmmirror.com
RUN --mount=type=cache,target=/tmp/npm-cache \
  npm i -g @openai/codex@0.93.0 @zed-industries/codex-acp@0.9.0 --cache /tmp/npm-cache \
  && echo "npm-no-cache-bust=$NPM_NO_CACHE_BUST"

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--config", "/config/config.toml"]
