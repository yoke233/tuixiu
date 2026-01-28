FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    openssh-client \
  && rm -rf /var/lib/apt/lists/*

RUN npm i -g @openai/codex @zed-industries/codex-acp

WORKDIR /workspace

CMD ["codex-acp"]

