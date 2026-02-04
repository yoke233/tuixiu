# Cookie + Refresh Token + WebSocket 认证 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把前端登录态从 `localStorage + Authorization header + WS?token=` 迁移到 `httpOnly Cookie + access/refresh`，并让 WebSocket 走 Cookie 完成认证，降低 token 被窃取/落日志的风险。

**Architecture:** 后端签发短期 `access token`（用于 API/WS）与长期 `refresh token`（仅用于换新 access），两者都只放在 `httpOnly` Cookie。前端不再保存 token；遇到 401 时自动调用 `/api/auth/refresh` 刷新后重试一次。WS 不再在 URL 上拼 `token`，直接连接，由浏览器自动带 Cookie 完成握手认证。

**Tech Stack:** Fastify 5 + `@fastify/jwt` + `@fastify/cookie` + `@fastify/websocket`，React + Vite，Vitest（后端/前端）。

---

## 设计约定（本计划默认）

- Cookie 名称：
  - `tuixiu_access`: access token（短期）
  - `tuixiu_refresh`: refresh token（长期；建议限制 Path 到 `/api/auth`）
- Token 载荷：
  - access: `{ userId, username, role, tokenType: "access" }`
  - refresh: `{ userId, username, role, tokenType: "refresh" }`
- 过期时间（可调）：
  - access：`AUTH_ACCESS_TOKEN_TTL_SECONDS`（默认建议 900 = 15min 或 1800 = 30min）
  - refresh：`AUTH_REFRESH_TOKEN_TTL_SECONDS`（默认建议 2592000 = 30d）
- 兼容策略（建议一次性切换，减少双栈复杂度）：
  - 前端不再使用 `authToken` 本地存储；后端仍保留 `Authorization: Bearer ...` 兼容非浏览器客户端（例如 `acp-proxy`）。
  - WebSocket：客户端不再支持 `?token=...`（避免落日志）；agent 仍可走 header bearer token。

---

### Task 0: 准备与基线校验（可选但推荐）

**Files:**
- Modify: `docker-compose.yml:1`（仅做本地/示例加固；生产更建议用部署系统注入 secrets）
- Modify: `.env.example:1`
- Modify: `backend/.env.example:1`

**Step 1: 写一个最小“上线前检查”清单（不改代码）**

在 PR 描述或本计划末尾记录：
- 生产必须设置强随机 `JWT_SECRET`（禁止使用 `dev-jwt-secret`）
- 生产必须设置 `COOKIE_SECURE=1`
- 不允许把后端 `3000` 端口直接暴露公网（应置于反向代理/IAP 后）

**Step 2: 运行现有测试（确保基线绿）**

运行：
```powershell
pnpm -C backend test
pnpm -C frontend test
```
期望：全部 PASS（若有既有失败，先记录，不在本改动里顺手修无关问题）。

**Step 3:（可选）为本次改动建分支**

```powershell
git switch -c feat/auth-cookie-refresh-ws
```

**Step 4:（可选）提交仅文档/配置的变更**

```powershell
git add .env.example backend/.env.example docker-compose.yml
git commit -m \"docs: add auth cookie env guidance\"
```

---

### Task 1: 后端增加 token TTL 配置（env）

**Files:**
- Modify: `backend/src/config.ts:1`
- Test: `backend/test/config.test.ts:1`
- Modify: `.env.example:1`
- Modify: `backend/.env.example:1`

**Step 1: 写失败用例：env 默认值包含新的 TTL**

在 `backend/test/config.test.ts` 追加一个测试（先红后绿）：
```ts
it(\"applies auth token ttl defaults\", () => {
  const prevDb = process.env.DATABASE_URL;
  delete process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS;
  delete process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS;
  process.env.DATABASE_URL = \"postgresql://example\";

  const env = loadEnv();
  expect(env.AUTH_ACCESS_TOKEN_TTL_SECONDS).toBeGreaterThan(0);
  expect(env.AUTH_REFRESH_TOKEN_TTL_SECONDS).toBeGreaterThan(env.AUTH_ACCESS_TOKEN_TTL_SECONDS);

  if (prevDb === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = prevDb;
});
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t \"applies auth token ttl defaults\"
```
期望：FAIL（提示 `AUTH_ACCESS_TOKEN_TTL_SECONDS` 不存在于 env 类型/解析结果）。

**Step 3: 最小实现：扩展 `backend/src/config.ts`**

在 `backend/src/config.ts` 的 `envSchema` 增加两个字段（默认值按上面的设计约定）：
```ts
AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
```

并在 `.env.example` 与 `backend/.env.example` 补充示例：
```env
JWT_SECRET=\"<set-a-strong-random-secret>\"
COOKIE_SECURE=1
AUTH_ACCESS_TOKEN_TTL_SECONDS=1800
AUTH_REFRESH_TOKEN_TTL_SECONDS=2592000
```

**Step 4: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t \"applies auth token ttl defaults\"
```
期望：PASS。

**Step 5: Commit**

```powershell
git add backend/src/config.ts backend/test/config.test.ts .env.example backend/.env.example
git commit -m \"feat(backend): add auth token ttl env\"
```

---

### Task 2: 后端 `registerAuth` 切换为 access cookie 名，并支持签发带过期的 token

**Files:**
- Modify: `backend/src/auth.ts:1`
- Test: `backend/test/utils/registerAuth.test.ts:1`

**Step 1: 写失败用例：cookie `tuixiu_access` 可通过 authenticate**

在 `backend/test/utils/registerAuth.test.ts` 增加用例（先失败）：
```ts
import cookie from \"@fastify/cookie\";

it(\"authenticate allows request with access cookie\", async () => {
  const server = createHttpServer();
  await server.register(cookie);
  const auth = await registerAuth(server, { jwtSecret: \"secret\" });

  server.get(\"/private\", { preHandler: auth.authenticate }, async () => ({ success: true }));

  const token = auth.sign({ userId: \"u1\", username: \"u1\", role: \"admin\", tokenType: \"access\" }, { expiresIn: 60 });
  const res = await server.inject({
    method: \"GET\",
    url: \"/private\",
    headers: { cookie: `tuixiu_access=${token}` },
  });

  expect(res.statusCode).toBe(200);
  await server.close();
});
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t \"authenticate allows request with access cookie\"
```
期望：FAIL（当前 cookieName 仍是 `tuixiu_token`，且 `sign` 不支持第二参数 options）。

**Step 3: 最小实现：修改 `backend/src/auth.ts`**

在 `backend/src/auth.ts`：
- 把 `cookieName` 从 `tuixiu_token` 改为 `tuixiu_access`（约 `backend/src/auth.ts:21`）
- 把 `AuthHelpers.sign` 改为支持可选 options（保持向后兼容）：
```ts
sign: (payload: any, options?: any) => string;
```
实现：
```ts
const sign = (payload: any, options?: any) => (server as any).jwt.sign(payload, options);
```

**Step 4: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t \"registerAuth\"
```
期望：PASS。

**Step 5: Commit**

```powershell
git add backend/src/auth.ts backend/test/utils/registerAuth.test.ts
git commit -m \"feat(backend): use access cookie for jwt and allow sign options\"
```

---

### Task 3: 后端 Auth Routes：登录/Bootstrap 下发 access+refresh Cookie（不再返回 token）

**Files:**
- Modify: `backend/src/routes/auth.ts:1`
- Modify: `backend/src/index.ts:1`（把 TTL 配置传给 routes）
- Test: `backend/test/routes/auth.test.ts:1`

**Step 1: 写失败用例：bootstrap/login 不再返回 token，并设置两枚 cookie**

把 `backend/test/routes/auth.test.ts` 的断言改成（先让它失败）：
```ts
expect(res.json()).toEqual({
  success: true,
  data: { user: { id: \"u1\", username: \"admin\", role: \"admin\" } },
});
expect(res.headers[\"set-cookie\"]).toBeTruthy();
expect(String(res.headers[\"set-cookie\"])).toMatch(/tuixiu_access=/);
expect(String(res.headers[\"set-cookie\"])).toMatch(/tuixiu_refresh=/);
expect(String(res.headers[\"set-cookie\"])).toMatch(/HttpOnly/i);
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t \"POST /api/auth/bootstrap creates first admin\"
```
期望：FAIL（旧返回含 token、且测试环境未注册 cookie 插件导致无 set-cookie）。

**Step 3: 最小实现：在测试里注册 cookie 插件**

在该测试用例创建 server 后追加：
```ts
import cookie from \"@fastify/cookie\";
await server.register(cookie);
```

**Step 4: 最小实现：修改 `backend/src/routes/auth.ts` 下发两枚 Cookie**

在 `backend/src/routes/auth.ts`：
- 把 `cookieName = \"tuixiu_token\"` 改为：
```ts
const accessCookieName = \"tuixiu_access\";
const refreshCookieName = \"tuixiu_refresh\";
```
- 拆出 cookieOptions（建议 refresh 限制 Path）：
```ts
const accessCookieOptions = (secure?: boolean) => ({ path: \"/\", httpOnly: true, sameSite: \"lax\" as const, secure: !!secure });
const refreshCookieOptions = (secure?: boolean) => ({ path: \"/api/auth\", httpOnly: true, sameSite: \"lax\" as const, secure: !!secure });
```
- 生成 token（需要从 deps 里拿 TTL；见下一 Task 传参）：
```ts
const accessToken = deps.auth.sign(
  { userId: user.id, username: user.username, role: user.role, tokenType: \"access\" },
  { expiresIn: deps.tokens.accessTtlSeconds },
);
const refreshToken = deps.auth.sign(
  { userId: user.id, username: user.username, role: user.role, tokenType: \"refresh\" },
  { expiresIn: deps.tokens.refreshTtlSeconds },
);
```
- 设置 cookie：
```ts
trySetAuthCookie({ reply, name: accessCookieName, token: accessToken, options: accessCookieOptions(deps.cookie?.secure) });
trySetAuthCookie({ reply, name: refreshCookieName, token: refreshToken, options: refreshCookieOptions(deps.cookie?.secure) });
```
- 返回体去掉 token：
```ts
return { success: true, data: { user: toPublicUser(user) } };
```

同时在 `makeAuthRoutes` 的 deps 类型里新增：
```ts
tokens: { accessTtlSeconds: number; refreshTtlSeconds: number };
```

并在 `backend/src/index.ts` 注册 routes 时传入（约 `backend/src/index.ts:100`）：
```ts
tokens: { accessTtlSeconds: env.AUTH_ACCESS_TOKEN_TTL_SECONDS, refreshTtlSeconds: env.AUTH_REFRESH_TOKEN_TTL_SECONDS },
```

**Step 5: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t \"Auth routes\"
```
期望：PASS（bootstrap/login 断言更新后）。

**Step 6: Commit**

```powershell
git add backend/src/routes/auth.ts backend/src/index.ts backend/test/routes/auth.test.ts
git commit -m \"feat(backend): issue access/refresh cookies and remove token response\"
```

---

### Task 4: 后端新增 `/api/auth/refresh`（刷新 access，并可选轮换 refresh）

**Files:**
- Modify: `backend/src/routes/auth.ts:1`
- Test: `backend/test/routes/auth.refresh.test.ts`（新建）

**Step 1: 写失败用例：refresh 能用 refresh cookie 换新 access**

新增 `backend/test/routes/auth.refresh.test.ts`：
```ts
import { describe, expect, it, vi } from \"vitest\";
import cookie from \"@fastify/cookie\";
\nimport { makeAuthRoutes } from \"../../src/routes/auth.js\";\nimport { registerAuth } from \"../../src/auth.js\";\nimport { createHttpServer } from \"../test-utils.js\";\n\nfunction pickSetCookie(res: any, name: string): string {\n  const raw = res.headers[\"set-cookie\"];\n  const list = Array.isArray(raw) ? raw : [raw].filter(Boolean);\n  const hit = list.find((s: string) => String(s).startsWith(name + \"=\"));\n  if (!hit) throw new Error(\"missing set-cookie: \" + name);\n  return String(hit);\n}\n\ndescribe(\"Auth refresh\", () => {\n  it(\"POST /api/auth/refresh issues new access cookie\", async () => {\n    const server = createHttpServer();\n    await server.register(cookie);\n    const auth = await registerAuth(server, { jwtSecret: \"secret\" });\n\n    const prisma = {\n      user: { count: vi.fn().mockResolvedValue(1) },\n    } as any;\n\n    await server.register(\n      makeAuthRoutes({\n        prisma,\n        auth,\n        tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 },\n        cookie: { secure: false },\n      }),\n      { prefix: \"/api/auth\" },\n    );\n\n    // 手工签一个 refresh cookie\n    const refresh = auth.sign({ userId: \"u1\", username: \"u1\", role: \"admin\", tokenType: \"refresh\" }, { expiresIn: 3600 });\n\n    const res = await server.inject({\n      method: \"POST\",\n      url: \"/api/auth/refresh\",\n      headers: { cookie: `tuixiu_refresh=${refresh}` },\n      payload: {},\n    });\n\n    expect(res.statusCode).toBe(200);\n    expect(res.json()).toEqual({ success: true, data: { ok: true } });\n    expect(pickSetCookie(res, \"tuixiu_access\")).toMatch(/HttpOnly/i);\n\n    await server.close();\n  });\n});\n```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t \"Auth refresh\"
```
期望：FAIL（路由不存在）。

**Step 3: 最小实现：在 `backend/src/routes/auth.ts` 增加 refresh 路由**

实现建议（放在 `/logout` 之前或之后都行）：
```ts
server.post(\"/refresh\", async (request, reply) => {
  const refresh = String((request as any)?.cookies?.tuixiu_refresh ?? \"\").trim();
  if (!refresh) return { success: false, error: { code: \"UNAUTHORIZED\", message: \"未登录\" } };

  let payload: any = null;
  try {
    payload = await (server as any).jwt.verify(refresh);
  } catch {
    reply.code(401);
    return { success: false, error: { code: \"UNAUTHORIZED\", message: \"未登录\" } };
  }

  if (!payload || payload.tokenType !== \"refresh\") {
    reply.code(401);
    return { success: false, error: { code: \"UNAUTHORIZED\", message: \"未登录\" } };
  }

  const accessToken = deps.auth.sign(
    { userId: payload.userId, username: payload.username, role: payload.role, tokenType: \"access\" },
    { expiresIn: deps.tokens.accessTtlSeconds },
  );
  trySetAuthCookie({ reply, name: \"tuixiu_access\", token: accessToken, options: accessCookieOptions(deps.cookie?.secure) });

  // 可选：每次 refresh 都轮换 refresh（注意：若不做服务端存储，轮换无法“作废旧 refresh”，只是减少同 token 长期复用）
  // const newRefresh = deps.auth.sign({ ...payload, tokenType: \"refresh\" }, { expiresIn: deps.tokens.refreshTtlSeconds });
  // trySetAuthCookie({ reply, name: \"tuixiu_refresh\", token: newRefresh, options: refreshCookieOptions(deps.cookie?.secure) });

  return { success: true, data: { ok: true } };
});
```

**Step 4: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t \"Auth refresh\"
```
期望：PASS。

**Step 5: Commit**

```powershell
git add backend/src/routes/auth.ts backend/test/routes/auth.refresh.test.ts
git commit -m \"feat(backend): add auth refresh endpoint\"
```

---

### Task 5: 后端 logout 清理两枚 cookie（并保持 200）

**Files:**
- Modify: `backend/src/routes/auth.ts:108`
- Test: `backend/test/routes/auth.refresh.test.ts:1`（追加 logout 覆盖）

**Step 1: 写失败用例：logout 清两枚 cookie**

在 `backend/test/routes/auth.refresh.test.ts` 追加：
```ts
it(\"POST /api/auth/logout clears access+refresh cookies\", async () => {
  const server = createHttpServer();
  await server.register(cookie);
  const auth = await registerAuth(server, { jwtSecret: \"secret\" });
  const prisma = { user: { count: vi.fn().mockResolvedValue(1) } } as any;
  await server.register(makeAuthRoutes({ prisma, auth, tokens: { accessTtlSeconds: 60, refreshTtlSeconds: 3600 }, cookie: { secure: false } }), { prefix: \"/api/auth\" });

  const res = await server.inject({ method: \"POST\", url: \"/api/auth/logout\", payload: {} });
  expect(res.statusCode).toBe(200);
  expect(String(res.headers[\"set-cookie\"])).toMatch(/tuixiu_access=;/);
  expect(String(res.headers[\"set-cookie\"])).toMatch(/tuixiu_refresh=;/);
  await server.close();
});
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t \"clears access\\+refresh\"
```
期望：FAIL（当前只清一个 cookie）。

**Step 3: 最小实现：logout 同时 clear 两个 cookie**

把 `/logout` 改成：
```ts
tryClearAuthCookie({ reply, name: accessCookieName, options: accessCookieOptions(deps.cookie?.secure) });
tryClearAuthCookie({ reply, name: refreshCookieName, options: refreshCookieOptions(deps.cookie?.secure) });
```

**Step 4: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t \"Auth refresh\"
```

**Step 5: Commit**

```powershell
git add backend/src/routes/auth.ts backend/test/routes/auth.refresh.test.ts
git commit -m \"fix(backend): clear both auth cookies on logout\"
```

---

### Task 6: 后端 WebSocket：客户端用 Cookie access 认证，禁用 `?token=...`

**Files:**
- Modify: `backend/src/websocket/gateway.ts:1539`
- Test: `backend/test/websocket/gateway.test.ts:1000`

**Step 1: 写失败用例：/ws/client 不再接受 query token**

在 `backend/test/websocket/gateway.test.ts` 的 “init registers websocket routes” 用例里，把 clientHandler 调用改成 header bearer 或 cookie：
```ts
await clientHandler(clientSocket as any, { url: \"/ws/client\", headers: { cookie: \"tuixiu_access=t\" } } as any);
```
并把 server.jwt.verify mock 改为：当 token 不是 `t` 就 throw（确保不是从 query 取到）。

**Step 2: 跑测试确认失败**

```powershell
pnpm -C backend test -- -t \"init registers websocket routes\"
```
期望：FAIL（当前 extractToken 仍会读取 query token，且 cookie 名是 tuixiu_token）。

**Step 3: 最小实现：修改 `extractToken`**

在 `backend/src/websocket/gateway.ts:1539` 附近：
- cookie 改为 `tuixiu_access`
- 对 client 连接：移除 `tokenFromQuery` 优先级（建议彻底不读 query token）

示例实现（推荐拆成两个函数）：
```ts
function extractBearerOrAccessCookie(request: any): string {
  const authHeader = String(request?.headers?.authorization ?? \"\").trim();
  const tokenFromHeader = authHeader.toLowerCase().startsWith(\"bearer \") ? authHeader.slice(7).trim() : \"\";
  const tokenFromCookie = String((request as any)?.cookies?.tuixiu_access ?? \"\").trim();
  return tokenFromCookie || tokenFromHeader;
}
```

然后：
- `authenticateClientSocket` 使用 `extractBearerOrAccessCookie`
- `authenticateAgentSocket` 可继续使用 header（也可继续兼容 query token，如确实需要）

**Step 4: 跑测试确认通过**

```powershell
pnpm -C backend test -- -t \"init registers websocket routes\"
```

**Step 5: Commit**

```powershell
git add backend/src/websocket/gateway.ts backend/test/websocket/gateway.test.ts
git commit -m \"feat(backend): authenticate client websocket via access cookie\"
```

---

### Task 7: 前端移除本地 token 存储与 Authorization header 注入

**Files:**
- Modify: `frontend/src/auth/storage.ts:1`
- Modify: `frontend/src/auth/AuthContext.ts:1`
- Modify: `frontend/src/auth/AuthProvider.tsx:1`
- Modify: `frontend/src/api/client.ts:1`
- Test: `frontend/src/App.test.tsx:1`

**Step 1: 写失败用例：AuthState 不再暴露 token**

先改类型会引发 TS 报错（作为“红”信号）。从 `frontend/src/auth/AuthContext.ts:5` 开始把：
```ts
token: string | null;
```
移除，并同步更新 `useAuth()` 默认返回值。

**Step 2: 跑 typecheck 确认失败点集中**

```powershell
pnpm -C frontend typecheck
```
期望：FAIL，提示 `token` 字段缺失（帮助定位需要改的调用点）。

**Step 3: 最小实现：删 token 存储与注入**

在 `frontend/src/auth/storage.ts:3`：
- 删除 `TOKEN_KEY`、`getStoredToken`、`setStoredToken`
- `clearStoredAuth` 仅清理 user

在 `frontend/src/api/client.ts:1`：
- 删除 `getStoredToken` import 与第 25-28 行 Authorization header 注入逻辑

在 `frontend/src/auth/AuthProvider.tsx:16`：
- 删除 `token` state（第 18 行）以及所有 `setStoredToken/setToken` 调用
- `hadStoredAuth` 改为只看 `getStoredUser()`

`frontend/src/App.test.tsx`：
- 移除对 `authToken` 的写入/清理，仅保留 `authUser`

**Step 4: 跑前端测试确认通过**

```powershell
pnpm -C frontend test
pnpm -C frontend typecheck
```
期望：PASS。

**Step 5: Commit**

```powershell
git add frontend/src/auth/storage.ts frontend/src/auth/AuthContext.ts frontend/src/auth/AuthProvider.tsx frontend/src/api/client.ts frontend/src/App.test.tsx
git commit -m \"refactor(frontend): remove local token storage and auth header injection\"
```

---

### Task 8: 前端实现 refresh：401 自动刷新并重试一次 + AuthProvider 启动时刷新

**Files:**
- Modify: `frontend/src/api/auth.ts:1`
- Modify: `frontend/src/api/client.ts:19`
- Modify: `frontend/src/auth/AuthProvider.tsx:21`
- Test: `frontend/src/api/client.refresh.test.ts`（新建）

**Step 1: 写失败用例：apiRequest 401 会 refresh 并重试**

新增 `frontend/src/api/client.refresh.test.ts`（用 `vi.stubGlobal('fetch', ...)`）：
```ts
import { describe, expect, it, vi } from \"vitest\";
import { apiGet } from \"./client\";\n\nfunction ok(body: any, status = 200) {\n  return new Response(JSON.stringify(body), { status, headers: { \"content-type\": \"application/json\" } });\n}\n\ndescribe(\"apiRequest refresh\", () => {\n  it(\"retries once after 401 by calling /auth/refresh\", async () => {\n    const fetchMock = vi.fn()\n      // first call: protected endpoint -> 401\n      .mockResolvedValueOnce(ok({ success: false, error: { code: \"UNAUTHORIZED\", message: \"未登录\" } }, 401))\n      // second call: refresh -> 200\n      .mockResolvedValueOnce(ok({ success: true, data: { ok: true } }, 200))\n      // third call: retry original -> 200\n      .mockResolvedValueOnce(ok({ success: true, data: { ok: true } }, 200));\n\n    vi.stubGlobal(\"fetch\", fetchMock as any);\n\n    const res = await apiGet<{ ok: true }>(\"/health\");\n    expect(res.ok).toBe(true);\n\n    const urls = fetchMock.mock.calls.map((c) => String(c[0]));\n    expect(urls.some((u) => u.includes(\"/api/auth/refresh\"))).toBe(true);\n\n    vi.unstubAllGlobals();\n  });\n});\n```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C frontend test -- -t \"apiRequest refresh\"
```
期望：FAIL（当前不会 refresh 重试）。

**Step 3: 最小实现：后端响应适配 + 前端 refresh 封装**

在 `frontend/src/api/auth.ts`：
- `AuthResponse` 改为仅 `{ user: User }`
- `bootstrapAuth/loginAuth` 不再解析 token，只校验 `user`
- 新增：
```ts
export async function refreshAuth(): Promise<void> {
  await apiPost(\"/auth/refresh\", {});
}
```

在 `frontend/src/api/client.ts:19`：
- 给 `apiRequest` 增加一个 `retry` 参数（默认 0）
- 当 `res.status === 401` 且 `path` 不是 `/auth/login|/auth/bootstrap|/auth/refresh|/auth/logout` 且 `retry===0`：
  - `await fetch(apiUrl(\"/auth/refresh\"), { method: \"POST\", credentials: \"include\", headers })`
  - 然后重试原请求一次
- 注意避免无限递归与刷新失败时吞错。

**Step 4: AuthProvider 初始化逻辑遇到 401 先 refresh 再 me**

在 `frontend/src/auth/AuthProvider.tsx:21`：
- `meAuth()` 失败且 httpStatus=401/403 时：
  - 先 `refreshAuth()`（忽略失败）
  - 再 `meAuth()`（成功则 authenticated，失败则 anonymous 并清理本地 user）

**Step 5: 跑测试确认通过**

```powershell
pnpm -C frontend test
pnpm -C frontend typecheck
```

**Step 6: Commit**

```powershell
git add frontend/src/api/auth.ts frontend/src/api/client.ts frontend/src/auth/AuthProvider.tsx frontend/src/api/client.refresh.test.ts
git commit -m \"feat(frontend): refresh on 401 and bootstrap auth from cookies\"
```

---

### Task 9: 前端 WebSocket：移除 token query，必要时在 1008/401 场景触发 refresh 后重连

**Files:**
- Modify: `frontend/src/hooks/useWsClient.ts:1`
- Modify: `frontend/src/hooks/useWsClient.test.tsx:1`
- Modify: `frontend/src/pages/issueDetail/useIssueDetailController.ts:547`
- Modify: `frontend/src/pages/session/useSessionController.ts:301`

**Step 1: 写失败用例：不再拼 token 参数**

更新 `frontend/src/hooks/useWsClient.test.tsx`：
- 删除 `TestComponentWithToken` 与 “appends token to ws url” 用例
- 增加断言：`instance.url` 不包含 `token=`
```ts
expect(String(instance.url)).not.toMatch(/token=/);
```

**Step 2: 跑测试确认失败**

```powershell
pnpm -C frontend test -- -t \"useWsClient\"
```
期望：FAIL（当前仍 appendToken）。

**Step 3: 最小实现：useWsClient 去 token 化**

在 `frontend/src/hooks/useWsClient.ts`：
- 删除 `appendToken` 与 `opts.token`
- `getWsUrl()` 直接返回 `${base}/ws/client`
- 保留 `ws.onclose` 的重连逻辑

（可选增强）如果 `onclose` code === 1008（后端 Unauthorized）：
- 调用一次 `fetch('/api/auth/refresh', { method:'POST', credentials:'include' })`（不要引入循环依赖）
- 再 scheduleReconnect

**Step 4: 更新 controller 调用点**

把：
```ts
const ws = useWsClient(onWs, { token: auth.token });
```
改为：
```ts
const ws = useWsClient(onWs);
```

**Step 5: 跑测试确认通过**

```powershell
pnpm -C frontend test
pnpm -C frontend typecheck
```

**Step 6: Commit**

```powershell
git add frontend/src/hooks/useWsClient.ts frontend/src/hooks/useWsClient.test.tsx frontend/src/pages/issueDetail/useIssueDetailController.ts frontend/src/pages/session/useSessionController.ts
git commit -m \"feat(frontend): authenticate websocket via cookies (no token in url)\"
```

---

### Task 10: 全量验证与回归（最后一步）

**Files:**
- (no code; verification only)

**Step 1: 后端测试**

```powershell
pnpm -C backend test
pnpm -C backend typecheck
```

**Step 2: 前端测试**

```powershell
pnpm -C frontend test
pnpm -C frontend typecheck
```

**Step 3: 本地联调（手工）**

```powershell
pnpm install
docker compose up -d
pnpm dev
```

检查点：
- 登录后浏览器 Application/Cookies 中能看到 `tuixiu_access`/`tuixiu_refresh`（HttpOnly）
- `localStorage` 不再出现 `authToken`
- 打开页面后 WS 连接成功（Network -> WS）
- access 过期后（可临时把 `AUTH_ACCESS_TOKEN_TTL_SECONDS=10`），自动 refresh 后 API/WS 能恢复

**Step 4: Commit（若有未提交变更）**

```powershell
git status
```

---

## 上线前检查清单（最小）

- 生产必须设置强随机 `JWT_SECRET`（禁止使用 `dev-jwt-secret`）
- 生产必须设置 `COOKIE_SECURE=1`
- 不允许把后端 `3000` 端口直接暴露公网（应置于反向代理/IAP 后）

## 后续增强（不在本次最小闭环内，但建议排期）

- Refresh Token 轮换 + 服务端存储（DB 记录 refresh session），实现“旧 refresh 失效/复用检测/单设备注销/全设备注销”。
- CORS 收紧：生产环境只允许同域；或按白名单配置（避免 `origin:true + credentials:true` 的泛化暴露）。
- 禁用/加锁 `/api/auth/bootstrap`：生产环境要求一次性 header token，避免首次上线被抢占 admin。
- 反向代理/IAP：把 `/api/*` 与 `/ws/*` 全部置于门禁后，仅 `/api/webhooks/*` 放行公网（保留签名校验与限流）。
