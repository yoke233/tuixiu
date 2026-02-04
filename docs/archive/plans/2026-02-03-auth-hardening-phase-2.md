# Auth Hardening Phase 2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在现有 cookie 登录体系之上，补齐 refresh 轮换+服务端存储、CORS 白名单、bootstrap 上线防抢占，以及 IAP/反向代理的落地文档。

**Architecture:** 后端引入 `RefreshSession` 表存储 refresh token 的哈希，实现“单设备注销/全设备注销/复用检测”。CORS 从全放开改成按白名单配置。/api/auth/bootstrap 引入一次性 header token 或生产禁用。IAP/反向代理不改运行时逻辑，仅提供部署文档与示例配置。

**Tech Stack:** Fastify 5 + Prisma + PostgreSQL + @fastify/cors + @fastify/jwt + @fastify/cookie；前端 React；测试 Vitest。

---

## 执行前置建议

- **先完成上一份最小闭环计划**（cookie + refresh + ws），再做本增强。
- 本计划涉及 Prisma 迁移，建议在**独立 worktree**执行，避免影响主分支。

---

### Task 1: Prisma 增加 RefreshSession 表

**Files:**
- Modify: `backend/prisma/schema.prisma:1`
- Create: `backend/prisma/migrations/<timestamp>_add_refresh_sessions/migration.sql`

**Step 1: 写失败测试（schema 约束）**

在 `backend/test` 新建一个轻量 schema 断言测试（先红）：
```ts
// backend/test/schema/refreshSessionSchema.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("schema", () => {
  it("contains RefreshSession model", () => {
    const schema = readFileSync("backend/prisma/schema.prisma", "utf8");
    expect(schema).toMatch(/model\\s+RefreshSession\\b/);
  });
});
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t "RefreshSession model"
```
期望：FAIL（未定义模型）。

**Step 3: 最小实现：添加模型**

在 `backend/prisma/schema.prisma` 添加：
```prisma
model RefreshSession {
  id          String   @id @default(uuid()) @db.Uuid
  userId      String   @db.Uuid
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  tokenHash   String   @unique @db.VarChar(128)
  rotatedFromId String? @db.Uuid
  rotatedFrom   RefreshSession? @relation("RefreshRotation", fields: [rotatedFromId], references: [id], onDelete: SetNull)
  rotatedTo     RefreshSession? @relation("RefreshRotation")

  createdAt   DateTime @default(now())
  lastUsedAt  DateTime?
  expiresAt   DateTime
  revokedAt   DateTime?

  ip          String?  @db.VarChar(64)
  userAgent   String?  @db.Text

  @@index([userId, createdAt(sort: Desc)])
  @@index([userId, revokedAt])
  @@index([expiresAt])
}
```

**Step 4: 生成迁移**

```powershell
pnpm -C backend prisma:migrate
```
期望：生成 `backend/prisma/migrations/*_add_refresh_sessions`。

**Step 5: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t "RefreshSession model"
```

**Step 6: Commit**

```powershell
git add backend/prisma/schema.prisma backend/prisma/migrations backend/test/schema/refreshSessionSchema.test.ts
git commit -m "feat(backend): add refresh session model"
```

---

### Task 2: 实现 refresh session 存储与轮换逻辑（服务端）

**Files:**
- Create: `backend/src/modules/auth/refreshSessions.ts`
- Modify: `backend/src/routes/auth.ts:1`
- Test: `backend/test/routes/auth.refresh.test.ts:1`（新建或复用）

**Step 1: 写失败测试：refresh 轮换 + 复用检测**

新增测试文件（先红）：
```ts
// backend/test/routes/auth.refresh.test.ts
import { describe, expect, it, vi } from "vitest";
import cookie from "@fastify/cookie";
import { makeAuthRoutes } from "../../src/routes/auth.js";
import { registerAuth } from "../../src/auth.js";
import { createHttpServer } from "../test-utils.js";

describe("auth refresh rotation", () => {
  it("rotates refresh token and rejects reused token", async () => {
    const server = createHttpServer();
    await server.register(cookie);
    const auth = await registerAuth(server, { jwtSecret: "secret" });

    const prisma = {
      user: { count: vi.fn().mockResolvedValue(1) },
      refreshSession: {
        create: vi.fn().mockResolvedValue({ id: "s1" }),
        findUnique: vi.fn().mockResolvedValue({ id: "s1", revokedAt: null, expiresAt: new Date(Date.now() + 3600_000) }),
        update: vi.fn().mockResolvedValue({ id: "s1", revokedAt: new Date() }),
      },
    } as any;

    await server.register(makeAuthRoutes({
      prisma,
      auth,
      tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 },
      cookie: { secure: false },
    }), { prefix: "/api/auth" });

    const refresh = auth.sign({ userId: "u1", username: "u1", role: "admin", tokenType: "refresh" }, { expiresIn: 3600 });

    const res1 = await server.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: `tuixiu_refresh=${refresh}` } });
    expect(res1.statusCode).toBe(200);

    // second use should be rejected (revoked/rotated)
    prisma.refreshSession.findUnique.mockResolvedValueOnce({ id: "s1", revokedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000) });
    const res2 = await server.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: `tuixiu_refresh=${refresh}` } });
    expect(res2.statusCode).toBe(401);

    await server.close();
  });
});
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t "auth refresh rotation"
```

**Step 3: 最小实现：新增 `refreshSessions` 模块**

`backend/src/modules/auth/refreshSessions.ts`：
```ts
import crypto from "node:crypto";
import type { PrismaDeps } from "../../db.js";

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createRefreshSession(prisma: PrismaDeps, input: {
  userId: string;
  token: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
  rotatedFromId?: string | null;
}) {
  return prisma.refreshSession.create({
    data: {
      id: crypto.randomUUID(),
      userId: input.userId,
      tokenHash: hashRefreshToken(input.token),
      expiresAt: input.expiresAt,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      ...(input.rotatedFromId ? { rotatedFromId: input.rotatedFromId } : {}),
    },
  } as any);
}

export async function findSessionByToken(prisma: PrismaDeps, token: string) {
  return prisma.refreshSession.findUnique({ where: { tokenHash: hashRefreshToken(token) } });
}

export async function revokeSession(prisma: PrismaDeps, id: string) {
  return prisma.refreshSession.update({ where: { id }, data: { revokedAt: new Date() } });
}

export async function revokeAllForUser(prisma: PrismaDeps, userId: string) {
  return prisma.refreshSession.updateMany({ where: { userId }, data: { revokedAt: new Date() } });
}
```

**Step 4: 改造 `/api/auth/login|bootstrap|refresh|logout`**

在 `backend/src/routes/auth.ts`：
- 登录/Bootstrap：创建 refresh session（存 hash），并设置 refresh cookie
- Refresh：查 `refreshSession` 是否存在、是否过期、是否已撤销；轮换时：
  - 先把旧 session `revokedAt` 标记
  - 创建新 session（`rotatedFromId` 指向旧）
  - 下发新 refresh cookie
- 复用检测：当同一 refresh 被再次使用且已 revoked/rotated，执行 `revokeAllForUser` 并 401
- Logout：如果带 refresh cookie，则 revoke 对应 session；再清 cookie
- 新增 `POST /api/auth/logout-all`：`revokeAllForUser` 并清 cookie

**Step 5: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t "auth refresh rotation"
```

**Step 6: Commit**

```powershell
git add backend/src/modules/auth/refreshSessions.ts backend/src/routes/auth.ts backend/test/routes/auth.refresh.test.ts
git commit -m "feat(backend): refresh token rotation with server-side sessions"
```

---

### Task 3: CORS 白名单配置

**Files:**
- Modify: `backend/src/config.ts:1`
- Modify: `backend/src/index.ts:70`
- Modify: `.env.example:1`
- Modify: `backend/.env.example:1`
- Test: `backend/test/config.test.ts:1`

**Step 1: 写失败测试（CORS env）**

在 `backend/test/config.test.ts` 加用例：
```ts
it("parses CORS_ALLOWED_ORIGINS", () => {
  process.env.DATABASE_URL = "postgresql://example";
  process.env.CORS_ALLOWED_ORIGINS = "https://a.com, https://b.com";
  const env = loadEnv();
  expect(env.CORS_ALLOWED_ORIGINS).toBe("https://a.com, https://b.com");
});
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t "CORS_ALLOWED_ORIGINS"
```

**Step 3: 最小实现：增加 env + index 里应用**

在 `backend/src/config.ts` 增加：
```ts
CORS_ALLOWED_ORIGINS: z.string().optional(),
```

在 `backend/src/index.ts` 用函数决定 origin：
```ts
const corsAllowed = String(env.CORS_ALLOWED_ORIGINS ?? "").trim();
const allowlist = corsAllowed
  ? corsAllowed.split(",").map((s) => s.trim()).filter(Boolean)
  : null;

await server.register(cors, {
  origin: allowlist
    ? (origin, cb) => cb(null, !origin || allowlist.includes(origin))
    : true,
  credentials: true,
});
```

**Step 4: 更新示例 env**

`.env.example` 与 `backend/.env.example` 增加：
```env
# CORS（生产建议设置白名单）
CORS_ALLOWED_ORIGINS="https://app.example.com,https://admin.example.com"
```

**Step 5: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t "CORS_ALLOWED_ORIGINS"
```

**Step 6: Commit**

```powershell
git add backend/src/config.ts backend/src/index.ts backend/test/config.test.ts .env.example backend/.env.example
git commit -m "feat(backend): add CORS allowlist support"
```

---

### Task 4: /api/auth/bootstrap 启动时生成一次性 token（文件存储，用后作废）

**Files:**
- Modify: `backend/src/config.ts:1`
- Modify: `backend/src/index.ts:1`
- Modify: `backend/src/routes/auth.ts:56`
- Create: `backend/src/modules/auth/bootstrapToken.ts`
- Modify: `.env.example:1`
- Modify: `backend/.env.example:1`
- Test: `backend/test/routes/auth.test.ts:1`

**Step 1: 写失败测试：当有 bootstrap token 时必须带 header 或 body**

在 `backend/test/routes/auth.test.ts` 加用例：
```ts
it("POST /api/auth/bootstrap requires bootstrap token when configured", async () => {
  const server = createHttpServer();
  const prisma = { user: { count: vi.fn().mockResolvedValue(0), create: vi.fn().mockResolvedValue({ id: "u1", username: "admin", role: "admin", passwordHash: "x" }) } } as any;
  const auth = { authenticate: vi.fn(), requireRoles: vi.fn(), sign: vi.fn().mockReturnValue("tok") } as any;
  await server.register(makeAuthRoutes({
    prisma,
    auth,
    bootstrap: { username: "admin", password: "123456" },
    cookie: { secure: false },
    tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 },
    bootstrapToken: "secret",
    bootstrapTokenFile: null,
  }), { prefix: "/api/auth" });

  const res = await server.inject({
    method: "POST",
    url: "/api/auth/bootstrap",
    payload: { username: "admin", password: "123456", bootstrapToken: "secret" },
  });
  expect(res.statusCode).toBe(401);
  await server.close();
});
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t "requires bootstrap token"
```

**Step 3: 最小实现：新增 env + 生成/读取 token 文件**

`backend/src/config.ts` 增加：
```ts
AUTH_BOOTSTRAP_TOKEN: z.string().optional(),
AUTH_BOOTSTRAP_TOKEN_FILE: z.string().optional(),
```

新增 `backend/src/modules/auth/bootstrapToken.ts`：
```ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type BootstrapTokenFile = { token: string; createdAt: string };

export async function readBootstrapToken(filePath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as BootstrapTokenFile;
    if (!parsed || typeof parsed.token !== "string") return null;
    return parsed.token.trim() || null;
  } catch {
    return null;
  }
}

export async function writeBootstrapToken(filePath: string): Promise<string> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const token = crypto.randomBytes(16).toString("hex");
  const payload: BootstrapTokenFile = { token, createdAt: new Date().toISOString() };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return token;
}

export async function removeBootstrapToken(filePath: string): Promise<void> {
  await fs.rm(filePath, { force: true });
}
```

`backend/src/index.ts`：
- 如果 `AUTH_BOOTSTRAP_TOKEN` 为空，且用户数为 0，则读取/生成 `AUTH_BOOTSTRAP_TOKEN_FILE`：
```ts
const bootstrapFile =
  env.AUTH_BOOTSTRAP_TOKEN_FILE?.trim() || path.join(os.homedir(), ".tuixiu", "bootstrap-token.json");
let bootstrapToken = env.AUTH_BOOTSTRAP_TOKEN?.trim() || null;
if (!bootstrapToken) {
  const userCount = await prisma.user.count().catch(() => 0);
  if (userCount === 0) {
    bootstrapToken = (await readBootstrapToken(bootstrapFile)) ?? (await writeBootstrapToken(bootstrapFile));
    server.log.info({ bootstrapFile }, `bootstrap token generated`);
    server.log.info({ bootstrapToken }, `use x-bootstrap-token once to initialize admin`);
  }
}
```

`backend/src/routes/auth.ts`：
- `makeAuthRoutes` deps 增加 `bootstrapToken?: string | null` 与 `bootstrapTokenFile?: string | null`
- `bodySchema` 增加 `bootstrapToken: z.string().min(1).max(200).optional()`
- 在 `/bootstrap` 开头检查 header 或 body：
```ts
if (deps.bootstrapToken) {
  const headerToken = String((request as any)?.headers?.["x-bootstrap-token"] ?? "").trim();
  const bodyToken = typeof body.bootstrapToken === "string" ? body.bootstrapToken.trim() : "";
  const provided = headerToken || bodyToken;
  if (provided !== deps.bootstrapToken) {
    reply.code(401);
    return { success: false, error: { code: "UNAUTHORIZED", message: "bootstrap token 无效" } };
  }
}
```
- 当 bootstrap 成功后，如果 `bootstrapTokenFile` 存在则删除文件（作废一次性 token）：
```ts
if (deps.bootstrapTokenFile) await removeBootstrapToken(deps.bootstrapTokenFile).catch(() => {});
```

在 `backend/src/index.ts` 传入：
```ts
bootstrapToken,
bootstrapTokenFile: bootstrapToken ? bootstrapFile : null,
```

**Step 4: 更新示例 env**

在 `.env.example` 与 `backend/.env.example` 增加：
```env
AUTH_BOOTSTRAP_TOKEN=""
AUTH_BOOTSTRAP_TOKEN_FILE=""
```

**Step 5: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t "requires bootstrap token"
```

**Step 6: Commit**

```powershell
git add backend/src/config.ts backend/src/index.ts backend/src/routes/auth.ts backend/src/modules/auth/bootstrapToken.ts backend/test/routes/auth.test.ts .env.example backend/.env.example
git commit -m "feat(backend): one-time bootstrap token file"
```

---

### Task 5: 前端初始化页面（输入 bootstrap token）

**Files:**
- Create: `frontend/src/pages/BootstrapPage.tsx`
- Modify: `frontend/src/pages/LoginPage.tsx:1`
- Modify: `frontend/src/App.tsx:1`
- Modify: `frontend/src/api/auth.ts:1`
- Test: `frontend/src/pages/BootstrapPage.test.tsx`

**Step 1: 写失败测试：Bootstrap 页面渲染并包含 token 输入框**

新建 `frontend/src/pages/BootstrapPage.test.tsx`：
```tsx
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AuthProvider } from "../auth/AuthProvider";
import { BootstrapPage } from "./BootstrapPage";

describe("BootstrapPage", () => {
  it("renders bootstrap token input", () => {
    render(
      <AuthProvider>
        <MemoryRouter>
          <BootstrapPage />
        </MemoryRouter>
      </AuthProvider>
    );
    expect(screen.getByLabelText("Bootstrap Token")).toBeInTheDocument();
  });
});
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C frontend test -- -t "BootstrapPage"
```

**Step 3: 最小实现：新增 BootstrapPage**

`frontend/src/pages/BootstrapPage.tsx`（示意）：
```tsx
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ThemeToggle } from "../components/ThemeToggle";
import { useAuth } from "../auth/AuthContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { GlobalErrorToast } from "@/components/GlobalErrorToast";

function getNextPath(search: string): string {
  try {
    const next = new URLSearchParams(search).get("next");
    return next && next.startsWith("/") ? next : "/issues";
  } catch {
    return "/issues";
  }
}

export function BootstrapPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const nextPath = useMemo(() => getNextPath(location.search), [location.search]);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrapToken, setBootstrapToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (auth.status === "authenticated") {
      navigate(nextPath, { replace: true });
    }
  }, [auth.status, navigate, nextPath]);

  async function submit() {
    setError(null);
    setSubmitting(true);
    try {
      await auth.bootstrap({
        username: username.trim() || undefined,
        password: password || undefined,
        bootstrapToken: bootstrapToken.trim() || undefined,
      });
      navigate(nextPath, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">初始化管理员</h1>
          <div className="muted">仅首次初始化时可用，需要 bootstrap token</div>
        </div>
        <ThemeToggle />
      </div>

      {error ? <GlobalErrorToast message={error} onDismiss={() => setError(null)} /> : null}

      <Card>
        <CardContent className="grid gap-4 p-6">
          <div className="grid gap-2">
            <Label htmlFor="bootstrapToken">Bootstrap Token</Label>
            <Input
              id="bootstrapToken"
              value={bootstrapToken}
              onChange={(e) => setBootstrapToken(e.target.value)}
              placeholder="从服务端启动日志复制"
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="username">用户名</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="admin"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">密码</Label>
            <Input
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="至少 6 位"
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                onClick={submit}
                disabled={submitting || auth.status === "loading" || !bootstrapToken.trim()}
              >
                初始化管理员
              </Button>
            </div>
            <Button variant="link" size="sm" asChild>
              <Link to="/login">返回登录</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 4: 更新 LoginPage 增加入口链接**

在 `frontend/src/pages/LoginPage.tsx` 的按钮区下方加：
```tsx
<div className="text-xs text-muted-foreground">
  没有管理员？前往 <Link to="/bootstrap">初始化管理员</Link>
</div>
```
并可移除原先 “初始化管理员（首次）” 按钮（避免重复入口）。

**Step 5: 更新路由**

`frontend/src/App.tsx` 增加：
```tsx
import { BootstrapPage } from "./pages/BootstrapPage";
```
在 routes 中新增：
```tsx
<Route path="/bootstrap" element={<BootstrapPage />} />
```

**Step 6: 更新 bootstrap API 支持 body token**

`frontend/src/api/auth.ts`：
- 更新类型：
```ts
export type AuthBootstrapInput = { username?: string; password?: string; bootstrapToken?: string };
```
- `bootstrapAuth(input: AuthBootstrapInput)` 直接把 `bootstrapToken` 放入 body。

**Step 7: 跑测试确认通过**

```powershell
pnpm -C frontend test -- -t "BootstrapPage"
pnpm -C frontend typecheck
```

**Step 8: Commit**

```powershell
git add frontend/src/pages/BootstrapPage.tsx frontend/src/pages/LoginPage.tsx frontend/src/App.tsx frontend/src/api/auth.ts frontend/src/pages/BootstrapPage.test.tsx
git commit -m "feat(frontend): add bootstrap page with token input"
```

---

### Task 6: 反向代理/IAP 部署文档

**Files:**
- Create: `docs/security/iap.md`
- Create: `docs/snippets/nginx-iap.conf`
- Modify: `README.md:1`

**Step 1: 写文档草稿（先占位）**

`docs/security/iap.md`：
```md
# IAP / 反向代理部署建议

## 目标
- /api/* 与 /ws/* 只允许经过门禁（IAP/SSO/MFA）访问
- /api/webhooks/* 可公网访问，但必须开启签名校验与限流

## Nginx 参考配置
见 `docs/snippets/nginx-iap.conf`
```

**Step 2: 写 Nginx 示例**

`docs/snippets/nginx-iap.conf`（示例结构即可）：
- TLS
- `auth_request` 或 `forward-auth`（指向 Authentik/自建 IdP）
- `/api/webhooks/` 单独 location 不做 auth_request

**Step 3: README 增加“公网部署注意事项”**

在 README 新增一段：
- 不要暴露后端 3000
- 建议 IAP/MFA
- 只放行 webhooks

**Step 4: Commit**

```powershell
git add docs/security/iap.md docs/snippets/nginx-iap.conf README.md
git commit -m "docs: add IAP/nginx guidance for public deployment"
```

---

## 回归验证（最后）

```powershell
pnpm -C backend test
pnpm -C backend typecheck
```

---

## 备注与风险

- Refresh 轮换要真正防复用，需要**服务端存储**配合（本计划已覆盖）。
- CORS 若设置白名单，注意前端域名与协议（https/http）必须一致。
- Bootstrap 禁用后，请确保已有管理员账户，否则无法初始化。
