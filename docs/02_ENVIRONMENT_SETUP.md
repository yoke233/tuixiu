# 环境搭建文档

本文档指导你准备开发环境，安装所有必要的依赖，并验证环境配置正确。

---

## 1. 系统要求

### 1.1 硬件要求

**最低配置**:

- CPU: 2 核
- 内存: 4GB
- 硬盘: 20GB 可用空间

**推荐配置**:

- CPU: 4 核
- 内存: 8GB
- 硬盘: 50GB SSD

### 1.2 操作系统

支持的系统:

- ✅ macOS 12+ (Monterey 或更新)
- ✅ Ubuntu 20.04+ / Debian 11+
- ✅ Windows 10+ (with WSL2)

**推荐**: macOS 或 Linux（开发体验更好）

---

## 2. 核心工具安装

### 2.1 Node.js (推荐 v18 LTS)

#### macOS

```bash
# 使用 Homebrew 安装
brew install node@18

# 验证安装
node --version  # 应输出 v18.x.x
npm --version   # 应输出 9.x.x
```

#### Ubuntu/Debian

```bash
# 使用 NodeSource 仓库
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证安装
node --version
npm --version
```

#### Windows (WSL2)

```bash
# 在 WSL2 中执行（同 Ubuntu）
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2.2 Golang (推荐 v1.21+)

#### macOS

```bash
# 使用 Homebrew 安装
brew install go

# 验证安装
go version  # 应输出 go version go1.21.x darwin/amd64
```

#### Ubuntu/Debian

```bash
# 下载最新版 Golang
wget https://go.dev/dl/go1.21.6.linux-amd64.tar.gz

# 解压到 /usr/local
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.21.6.linux-amd64.tar.gz

# 添加到 PATH
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc

# 验证安装
go version
```

#### Windows

```bash
# 下载并安装 MSI 安装包
# https://go.dev/dl/go1.21.6.windows-amd64.msi

# 验证安装（在 CMD 或 PowerShell 中）
go version
```

### 2.3 PostgreSQL (推荐 v14)

#### macOS

```bash
# 使用 Homebrew 安装
brew install postgresql@14

# 启动服务
brew services start postgresql@14

# 验证安装
psql --version  # 应输出 psql (PostgreSQL) 14.x
```

#### Ubuntu/Debian

```bash
# 添加官方仓库
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt-get update

# 安装 PostgreSQL
sudo apt-get install -y postgresql-14

# 启动服务
sudo systemctl start postgresql
sudo systemctl enable postgresql

# 验证安装
psql --version
```

#### Docker 方式（推荐用于开发）

```bash
# 启动 PostgreSQL 容器
docker run -d \
  --name postgres-dev \
  -e POSTGRES_USER=acp_user \
  -e POSTGRES_PASSWORD=acp_password \
  -e POSTGRES_DB=acp_system \
  -p 5432:5432 \
  -v postgres_data:/var/lib/postgresql/data \
  postgres:14

# 验证连接
docker exec -it postgres-dev psql -U acp_user -d acp_system
```

### 2.4 Git

#### 所有平台

```bash
# 验证 Git 已安装（通常系统自带）
git --version  # 应输出 git version 2.x.x

# 如果未安装
# macOS:
brew install git

# Ubuntu/Debian:
sudo apt-get install -y git
```

### 2.5 Docker (可选，但推荐)

#### macOS

```bash
# 下载并安装 Docker Desktop
# https://www.docker.com/products/docker-desktop

# 验证安装
docker --version
docker-compose --version
```

#### Ubuntu/Debian

```bash
# 安装 Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 添加当前用户到 docker 组
sudo usermod -aG docker $USER

# 安装 Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/download/v2.15.1/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# 验证安装
docker --version
docker-compose --version
```

---

## 3. Codex Agent 准备

### 3.1 安装 Codex CLI

**[待定]** 根据实际使用的 Codex 版本更新

假设 Codex 提供了二进制文件或 npm 包:

#### 方式 1: 二进制下载

```bash
# 下载（示例 URL，需替换为实际地址）
curl -L https://example.com/codex-cli-latest -o /usr/local/bin/codex
chmod +x /usr/local/bin/codex

# 验证安装
codex --version
```

#### 方式 2: npm 全局安装

```bash
npm install -g @codex/cli

# 验证安装
codex --version
```

### 3.2 验证 ACP 支持

```bash
# 检查 Codex 是否支持 ACP
codex --help | grep -i acp

# 应该看到类似输出:
#   --acp    Enable Agent Client Protocol mode
```

如果你使用的 `codex` CLI **没有** `--acp` 选项，可以使用 `codex-acp`（`https://github.com/zed-industries/codex-acp`）作为 ACP Agent：

```bash
npx --yes @zed-industries/codex-acp --help
```

### 3.3 测试 Codex (可选)

```bash
# 创建测试目录
mkdir -p ~/codex-test
cd ~/codex-test

# 初始化 Git 仓库
git init
echo "# Test Repo" > README.md
git add README.md
git commit -m "Initial commit"

# 启动 Codex (非 ACP 模式测试)
codex

# 在 Codex 交互界面中输入:
# > 帮我在 README.md 中添加一个安装章节

# 验证 Codex 可以正常工作
```

---

## 4. GitLab 配置

### 4.1 创建 Personal Access Token

1. 登录你的 GitLab 实例（https://gitlab.example.com）
2. 进入 **User Settings → Access Tokens**
3. 创建新 Token:
   - Name: `ACP System`
   - Scopes: ✅ `api`, ✅ `write_repository`
   - Expiration: 1 year（或根据公司政策）
4. 点击 **Create personal access token**
5. **立即复制 Token**（只显示一次！）
   - 格式: `glpat-xxxxxxxxxxxxxxxxxxxx`

**保存 Token**:

```bash
# 创建环境变量文件（不要提交到 Git）
echo "GITLAB_ACCESS_TOKEN=glpat-your-token-here" > .env
```

### 4.2 创建测试项目

1. 在 GitLab 上创建新项目:
   - Project Name: `acp-test-project`
   - Visibility: Private
   - Initialize with README: ✅

2. 克隆项目到本地:

```bash
git clone https://gitlab.example.com/your-username/acp-test-project.git
cd acp-test-project
```

3. 记录 Project ID:

```bash
# 在项目页面 Settings → General 中找到 Project ID
# 示例: Project ID: 123

# 保存到环境变量
echo "GITLAB_PROJECT_ID=123" >> .env
```

### 4.3 配置 GitLab CI (可选，但推荐)

在项目根目录创建 `.gitlab-ci.yml`:

```yaml
# .gitlab-ci.yml
stages:
  - test
  - build

test_job:
  stage: test
  script:
    - echo "Running tests..."
    - npm install # 或 pip install
    - npm test # 或 pytest

build_job:
  stage: build
  script:
    - echo "Building application..."
    - npm run build
  only:
    - merge_requests
```

提交并推送:

```bash
git add .gitlab-ci.yml
git commit -m "Add CI config"
git push origin main
```

### 4.4 配置 Webhook（稍后在后端启动后配置）

**占位记录**:

- Webhook URL: `https://your-domain.com/webhooks/gitlab`（暂时未知）
- Secret Token: 生成随机字符串
  ```bash
  # 生成 Secret Token
  openssl rand -hex 32
  # 保存输出到 .env
  echo "GITLAB_WEBHOOK_SECRET=your-generated-secret" >> .env
  ```

---

## 5. 项目初始化

### 5.1 克隆或创建项目仓库

**方式 1: 从 Git 克隆**（如果已有代码）

```bash
git clone https://github.com/your-org/acp-system.git
cd acp-system
```

**方式 2: 从零创建**

```bash
mkdir acp-system
cd acp-system
git init
```

### 5.2 创建目录结构

```bash
# 创建主要目录
mkdir -p backend
mkdir -p frontend
mkdir -p acp-proxy
mkdir -p database/migrations
mkdir -p docs
mkdir -p docker

# 创建 .gitignore
cat > .gitignore << 'EOF'
node_modules/
.env
*.log
dist/
build/
__pycache__/
*.pyc
.DS_Store
EOF
```

---

## 6. 后端 Orchestrator 初始化

### 6.1 初始化 Node.js 项目

```bash
cd backend

# 初始化 package.json
npm init -y

# 安装核心依赖
npm install fastify @fastify/cors @fastify/websocket
npm install pg
npm install dotenv
npm install socket.io

# 安装开发依赖
npm install -D typescript @types/node
npm install -D ts-node nodemon
npm install -D @types/pg

# 初始化 TypeScript
npx tsc --init
```

### 6.2 配置 TypeScript

编辑 `backend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### 6.3 创建项目结构

```bash
mkdir -p src/routes
mkdir -p src/services
mkdir -p src/models
mkdir -p src/utils
mkdir -p src/types

# 创建入口文件
touch src/index.ts
```

### 6.4 配置环境变量

创建 `backend/.env`:

```bash
# 数据库配置
DATABASE_URL=postgresql://acp_user:acp_password@localhost:5432/acp_system

# 服务器配置
PORT=3000
HOST=0.0.0.0

# GitLab 配置
GITLAB_URL=https://gitlab.example.com
GITLAB_ACCESS_TOKEN=glpat-your-token-here
GITLAB_PROJECT_ID=123
GITLAB_WEBHOOK_SECRET=your-generated-secret

# 日志级别
LOG_LEVEL=debug
```

### 6.5 配置运行脚本

编辑 `backend/package.json`，添加 scripts:

```json
{
  "scripts": {
    "dev": "nodemon --exec ts-node src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "migrate": "node dist/migrations/run.js"
  }
}
```

---

## 7. 前端 Web UI 初始化

### 7.1 创建 React 项目

```bash
cd frontend

# 使用 Vite 创建项目（推荐，比 CRA 快）
npm create vite@latest . -- --template react-ts

# 安装依赖
npm install

# 安装 UI 组件库
npm install antd

# 安装路由
npm install react-router-dom

# 安装 HTTP 客户端
npm install axios

# 安装 WebSocket 客户端
npm install socket.io-client
```

### 7.2 配置环境变量

创建 `frontend/.env.development`:

```bash
VITE_API_URL=http://localhost:3000/api
VITE_WS_URL=ws://localhost:3000
```

创建 `frontend/.env.production`:

```bash
VITE_API_URL=https://your-domain.com/api
VITE_WS_URL=wss://your-domain.com
```

---

## 8. ACP Proxy 初始化

### 8.1 初始化 Golang 项目

```bash
cd acp-proxy

# 初始化 Go module
go mod init acp-proxy

# 安装依赖
go get github.com/gorilla/websocket
go get github.com/spf13/viper  # 配置管理（可选）
```

### 8.2 创建项目结构

```bash
mkdir -p cmd/proxy
mkdir -p internal/agent
mkdir -p internal/websocket
mkdir -p internal/config

# 创建主入口
cat > cmd/proxy/main.go << 'EOF'
package main

import (
    "flag"
    "log"
    "acp-proxy/internal/config"
    "acp-proxy/internal/proxy"
)

func main() {
    configPath := flag.String("config", "config.json", "配置文件路径")
    flag.Parse()

    cfg, err := config.Load(*configPath)
    if err != nil {
        log.Fatalf("Failed to load config: %v", err)
    }

    proxy := proxy.New(cfg)
    if err := proxy.Start(); err != nil {
        log.Fatalf("Failed to start proxy: %v", err)
    }
}
EOF
```

### 8.3 配置文件模板

创建 `acp-proxy/config.json.example`:

```json
{
  "orchestrator_url": "ws://localhost:3000/ws/agent",
  "auth_token": "your-auth-token-here",
  "agent": {
    "id": "codex-local-1",
    "name": "Codex Local Agent 1",
    "command": "codex",
    "args": ["--acp"],
    "capabilities": {
      "languages": ["javascript", "typescript", "python"],
      "frameworks": ["react", "fastify"],
      "tools": ["git", "npm"]
    },
    "max_concurrent": 2,
    "workspace": "/path/to/projects"
  }
}
```

使用时复制为 `config.json`:

```bash
cp config.json.example config.json
# 编辑 config.json，填入实际值
```

### 8.4 构建可执行文件

```bash
# 构建（Node/TypeScript 版 Proxy）
cd acp-proxy
pnpm build
pnpm start
```

---

## 9. 数据库初始化

### 9.1 创建数据库

```bash
# 如果使用本地 PostgreSQL
psql -U postgres

# 在 psql 中执行:
CREATE USER acp_user WITH PASSWORD 'acp_password';
CREATE DATABASE acp_system OWNER acp_user;
\q
```

### 9.2 迁移表结构（Prisma ORM，推荐）

本仓库数据库层使用 **Prisma ORM**（见 `backend/prisma/schema.prisma`），迁移文件位于 `backend/prisma/migrations/`，通过 `prisma migrate` 应用到数据库，**不需要手写 SQL**。

```bash
cd backend
pnpm prisma:migrate
```

### 9.3 验证数据库

```bash
# 连接数据库
psql -U acp_user -d acp_system

# 查看表
\dt

# 应该看到:
#   public | agents    | table | acp_user
#   public | artifacts | table | acp_user
#   public | events    | table | acp_user
#   public | issues    | table | acp_user
#   public | projects  | table | acp_user
#   public | runs      | table | acp_user
```

---

## 10. Docker Compose 配置（可选）

如果你想用 Docker 快速启动数据库（推荐）：

仓库根目录已提供 `docker-compose.yml`（仅包含 Postgres），直接启动即可：

```bash
docker compose up -d
```

---

## 11. 验证环境

### 11.1 检查清单

运行以下命令，确保所有工具已正确安装:

```bash
# 创建验证脚本
cat > verify-setup.sh << 'EOF'
#!/bin/bash

echo "=== 环境验证 ==="
echo ""

# Node.js
echo -n "Node.js: "
node --version && echo "✅" || echo "❌"

# Golang
echo -n "Golang: "
go version && echo "✅" || echo "❌"

# PostgreSQL
echo -n "PostgreSQL: "
psql --version && echo "✅" || echo "❌"

# Git
echo -n "Git: "
git --version && echo "✅" || echo "❌"

# Docker (可选)
echo -n "Docker: "
docker --version && echo "✅" || echo "❌ (optional)"

# Codex
echo -n "Codex CLI: "
codex --version && echo "✅" || echo "❌"

echo ""
echo "=== 数据库连接测试 ==="
psql -U acp_user -d acp_system -c "SELECT 1;" && echo "✅ 数据库连接成功" || echo "❌ 数据库连接失败"

echo ""
echo "=== GitLab 连接测试 ==="
# 需要安装 curl 和 jq
curl -s -H "PRIVATE-TOKEN: $GITLAB_ACCESS_TOKEN" \
  "$GITLAB_URL/api/v4/projects/$GITLAB_PROJECT_ID" | jq -r '.name' && \
  echo "✅ GitLab API 连接成功" || echo "❌ GitLab API 连接失败"

EOF

chmod +x verify-setup.sh
./verify-setup.sh
```

### 11.2 预期输出

```
=== 环境验证 ===

Node.js: v18.x.x ✅
Golang: go version go1.21.x linux/amd64 ✅
PostgreSQL: psql (PostgreSQL) 14.x ✅
Git: git version 2.x.x ✅
Docker: Docker version 20.x.x ✅
Codex CLI: codex version x.x.x ✅

=== 数据库连接测试 ===
✅ 数据库连接成功

=== GitLab 连接测试 ===
acp-test-project
✅ GitLab API 连接成功
```

---

## 12. 常见问题

### Q1: PostgreSQL 连接失败

**错误**: `psql: error: connection to server on socket ... failed`

**解决**:

```bash
# 检查 PostgreSQL 是否运行
# macOS:
brew services list | grep postgresql

# Ubuntu:
sudo systemctl status postgresql

# 如果未运行，启动服务
# macOS:
brew services start postgresql@14

# Ubuntu:
sudo systemctl start postgresql
```

### Q2: npm install 失败

**错误**: `EACCES: permission denied`

**解决**:

```bash
# 修复 npm 权限
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

### Q3: GitLab API 返回 401 Unauthorized

**原因**: Token 无效或权限不足

**解决**:

1. 检查 Token 是否正确复制（没有多余空格）
2. 确认 Token 的 Scopes 包含 `api` 和 `write_repository`
3. 确认 Token 未过期

### Q4: Codex 找不到命令

**错误**: `command not found: codex`

**解决**:

```bash
# 检查 Codex 是否在 PATH 中
echo $PATH

# 如果安装在 /usr/local/bin，确保该目录在 PATH 中
export PATH="/usr/local/bin:$PATH"

# 添加到 .bashrc 或 .zshrc
echo 'export PATH="/usr/local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

## 13. 下一步

环境准备完成后，继续阅读:

- **03_COMPONENT_IMPLEMENTATION.md** - 组件实现要点
- **04_ACP_INTEGRATION_SPEC.md** - ACP 协议集成规范

---

## 附录: 快速启动脚本

为了方便团队成员快速启动，创建 `quick-start.sh`:

```bash
#!/bin/bash

echo "=== ACP System 快速启动 ==="

# 1. 启动 PostgreSQL（如果使用 Docker）
echo "启动 PostgreSQL..."
docker start postgres-dev 2>/dev/null || docker run -d \
  --name postgres-dev \
  -e POSTGRES_USER=acp_user \
  -e POSTGRES_PASSWORD=acp_password \
  -e POSTGRES_DB=acp_system \
  -p 5432:5432 \
  postgres:14

# 2. 启动后端
echo "启动后端..."
cd backend
npm run dev &
BACKEND_PID=$!

# 3. 启动前端
echo "启动前端..."
cd ../frontend
npm run dev &
FRONTEND_PID=$!

# 4. 启动 Proxy（可选）
# cd ../acp-proxy
# source venv/bin/activate
# python src/proxy.py &
# PROXY_PID=$!

echo ""
echo "=== 启动完成 ==="
echo "后端: http://localhost:3000"
echo "前端: http://localhost:8080"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 等待用户中断
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT
wait
```

使用:

```bash
chmod +x quick-start.sh
./quick-start.sh
```
