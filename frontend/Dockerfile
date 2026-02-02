FROM node:lts-alpine3.17 AS build
WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PNPM_STORE_PATH=/pnpm/store
ENV PNPM_REGISTRY=https://registry.npmmirror.com
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/package.json
RUN pnpm config set store-dir $PNPM_STORE_PATH
RUN pnpm install --frozen-lockfile --filter ./frontend...

COPY frontend frontend
RUN pnpm -C frontend build

FROM nginx:1.27-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
