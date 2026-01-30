FROM node:20-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY acp-proxy/package.json acp-proxy/tsconfig.json ./acp-proxy/

RUN corepack enable
RUN pnpm install --filter ./acp-proxy... --frozen-lockfile

COPY acp-proxy ./acp-proxy
RUN pnpm -C acp-proxy build

FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/acp-proxy /app/acp-proxy

WORKDIR /app/acp-proxy

RUN npm i -g @openai/codex@0.92.0 @zed-industries/codex-acp@0.9.0 --cache /tmp/npm-cache \
  && npm cache clean --force \
  && rm -rf /tmp/npm-cache \
  && echo "npm-no-cache-bust=$NPM_NO_CACHE_BUST"

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--config", "/config/config.toml"]
