---
title: "IAP / 反向代理部署建议"
owner: "platform"
status: "active"
last_reviewed: "2026-02-03"
---

# IAP / 反向代理部署建议

## 目标
- `/api/*` 与 `/ws/*` 只允许经过门禁（IAP/SSO/MFA）访问
- `/api/webhooks/*` 可公网访问，但必须开启签名校验与限流

## Nginx 参考配置
见 `docs/snippets/nginx-iap.conf`
