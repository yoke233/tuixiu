---
title: "Cloudflare Tunnel 给 GitHub Webhook 提供公网 HTTPS URL（Windows / PowerShell）"
owner: "@tuixiu-maintainers"
status: "active"
last_reviewed: "2026-01-27"
---

# Cloudflare Tunnel（cloudflared）给 GitHub Webhook 提供稳定公网 HTTPS URL（Windows / PowerShell）

目标：把本机 `http://127.0.0.1:3000` 安全映射成 `https://webhook.yourdomain.com`，然后在 GitHub Webhook 里填：

- `https://webhook.yourdomain.com/api/webhooks/github`

> 本仓库后端已内置 GitHub webhook 接口：`POST /api/webhooks/github`，并支持 `X-Hub-Signature-256`（HMAC-SHA256）签名校验（对应 `backend/.env` 的 `GITHUB_WEBHOOK_SECRET`）。

---

## 0) 前置条件

- 你有一个已接入 Cloudflare 的域名（可以创建 `webhook.yourdomain.com` 这类子域）。
- 本机能访问外网（不需要入站公网端口；cloudflared 会主动连 Cloudflare）。
- 本仓库后端在本机可用：`http://127.0.0.1:3000`（或你自定义端口）。

启动后端（示例）：

```powershell
pnpm -C backend dev
```

配置 webhook secret（推荐）：

- 复制 `backend/.env.example` → `backend/.env`
- 设置：`GITHUB_WEBHOOK_SECRET="你自己的随机字符串"`

---

## 1) 安装 cloudflared（一次性）

推荐用 winget（没有的话也可去 Cloudflare 官方下载）：

```powershell
winget install --id Cloudflare.cloudflared -e
```

安装后确认：

```powershell
cloudflared --version
```

---

## 2) 登录 Cloudflare（一次性）

```powershell
cloudflared tunnel login
```

会打开浏览器完成授权。

---

## 3) 创建一个“长期固定”的 Tunnel（一次性）

```powershell
cloudflared tunnel create tuixiu-gh-webhook
```

它会在 `%USERPROFILE%\.cloudflared\` 里生成一个类似 `<TUNNEL-UUID>.json` 的凭据文件（后面要用到这个路径）。

---

## 4) 写 tunnel 配置（本地管理）

在 `%USERPROFILE%\.cloudflared\config.yml` 创建/编辑（示例）：

```yaml
tunnel: tuixiu-gh-webhook
credentials-file: C:\Users\<你>\.cloudflared\<TUNNEL-UUID>.json

ingress:
  - hostname: webhook.yourdomain.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

说明：

- `service` 只写到端口即可；GitHub Webhook 的路径写在 Payload URL 里（例如 `/api/webhooks/github`）。
- 如果你后端端口不是 `3000`，这里同步改掉即可。

---

## 5) 把域名指向 tunnel（一次性）

自动创建 DNS 记录（推荐）：

```powershell
cloudflared tunnel route dns tuixiu-gh-webhook webhook.yourdomain.com
```

---

## 6) 运行 tunnel

前台运行（便于看日志）：

```powershell
cloudflared tunnel run tuixiu-gh-webhook
```

你也可以把它装成 Windows Service（长期跑）：

```powershell
cloudflared service install
```

---

## 7) 配置 GitHub Webhook

GitHub 仓库 → **Settings → Webhooks → Add webhook**

- **Payload URL**：`https://webhook.yourdomain.com/api/webhooks/github`
- **Content type**：`application/json`
- **Secret**：与 `backend/.env` 的 `GITHUB_WEBHOOK_SECRET` 一致
- **Which events**：至少勾选 **Issues**；如要 CI 回写，再勾选 **Workflow runs** / **Check runs** / **Check suites**

保存后 GitHub 会先发一次 `ping`，在 Webhooks 页面能看到投递结果。

---

## 8) 快速排错

- GitHub Webhooks 页面：点开某次投递 → 看 Request/Response/重试原因。
- 本地后端日志：确认收到了 `x-github-event`（比如 `ping`/`issues`/`workflow_run`）。
- cloudflared 日志：确认没有 404/502（通常是本地端口不通或后端没启动）。

