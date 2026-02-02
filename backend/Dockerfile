FROM node:lts-alpine3.17 AS base
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PNPM_STORE_PATH=/pnpm/store
ENV PNPM_REGISTRY=https://registry.npmmirror.com
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
RUN pnpm config set store-dir $PNPM_STORE_PATH
RUN pnpm install --frozen-lockfile --filter @acp/backend...

FROM deps AS build
COPY backend backend
RUN pnpm -C backend prisma:generate
RUN pnpm -C backend build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY backend/prisma backend/prisma
RUN pnpm config set store-dir $PNPM_STORE_PATH
RUN pnpm install --prod --frozen-lockfile --filter @acp/backend...
RUN pnpm -C backend prisma:generate
COPY --from=build /app/backend/dist /app/backend/dist
EXPOSE 3000
CMD ["sh", "-c", "pnpm -C backend prisma:deploy && node backend/dist/index.js"]
