FROM node:20-slim

# 创建并编辑 sources.list 文件
RUN sed -i 's@deb.debian.org@mirrors.aliyun.com@g' /etc/apt/sources.list.d/debian.sources

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  git \
  openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g @openai/codex@0.92.0 @zed-industries/codex-acp@0.9.0 --cache /tmp/npm-cache \
  && npm cache clean --force \
  && rm -rf /tmp/npm-cache \
  && echo "npm-no-cache-bust=$NPM_NO_CACHE_BUST"

WORKDIR /workspace

CMD ["codex-acp"]
