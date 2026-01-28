# Repository Guidelines

## Project Structure

- `backend/`: Fastify orchestrator (REST API + WebSocket gateway). Prisma schema/migrations live in `backend/prisma/`. Backend unit tests live in `backend/test/`.
- `acp-proxy/`: WebSocket ↔ ACP bridge and agent launcher. Runtime config is `acp-proxy/config.toml` (copy from `config.toml.example`).
- `frontend/`: Vite + React UI. Pages in `frontend/src/pages/`, reusable UI in `frontend/src/components/`, test setup in `frontend/src/test/`.
- `docs/`: architecture, PRD, and implementation notes.
- `.worktrees/`: generated git worktrees for Runs. Don’t edit manually and never commit it.

## Build, Test, and Development Commands

This repo is a `pnpm` workspace (Node.js 20+ recommended). Run commands from the repo root unless noted.

```powershell
pnpm install
docker compose up -d
pnpm dev
```

- `pnpm dev`: starts all packages (`backend`, `acp-proxy`, `frontend`) in watch mode.
- `pnpm -C backend prisma:migrate`: applies local DB migrations (required on first run).
- `pnpm lint` / `pnpm typecheck`: runs ESLint / TypeScript checks across the workspace.
- `pnpm test` / `pnpm test:coverage`: runs Vitest suites (and coverage where configured).

## Coding Style & Naming Conventions

- TypeScript + ESM (`"type": "module"`). Prefer 2-space indentation.
- Follow local formatting in each package (e.g., quote style) and keep diffs minimal.
- Lint rules are defined in each package’s `eslint.config.js`.
- Naming:
  - Backend modules: `camelCase.ts` (e.g., `backend/src/routes/githubIssues.ts`)
  - React components: `PascalCase.tsx` (e.g., `frontend/src/components/RunConsole.tsx`)
  - Tests: `*.test.ts` / `*.test.tsx`

## Testing Guidelines

- Framework: Vitest (frontend uses jsdom + Testing Library).
- Coverage thresholds are enforced in `backend/vitest.config.ts` and `frontend/vitest.config.ts`.
- Run a focused test: `pnpm -C backend test -- -t "loadEnv"` (Vitest name filter).

## Commit & Pull Request Guidelines

- Commits follow Conventional Commits seen in history: `feat:`, `fix:`, `docs:`, `refactor:` with optional scope (e.g., `feat(frontend): …`).
- PRs should include: a clear description, linked Issue/Run ID, screenshots for UI changes, and passing `pnpm lint` + `pnpm test`.

## Branching & Branch Name Guidelines

- Default branch: `main`. Create new branches from the latest `main`.
- Keep branches short-lived: open a PR early and merge small, focused changes.
- Naming format:
  - `<type>/<scope?>/<id?>-<short-desc>`
  - Use lowercase `kebab-case` for `scope` and `short-desc` (ASCII only).
  - Prefer an Issue/Run identifier for `id` (e.g., `gh-1234`, `run-20260127-01`).
- Recommended `type` values: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`, `ci`, `perf`, `revert`, `hotfix`, `release`.
- Examples:
  - `feat/frontend/gh-1234-run-console-filter`
  - `fix/backend/run-20260127-01-ws-reconnect`
  - `docs/gh-1200-branch-naming`
  - `chore/deps/pnpm-upgrade`
  - `release/1.8.0`

## Security & Configuration Tips

- Copy `backend/.env.example` → `backend/.env` and `acp-proxy/config.toml.example` → `acp-proxy/config.toml`.
- Treat PATs/API keys as secrets (e.g., `OPENAI_API_KEY`, GitHub tokens). Never commit them or paste into logs/issues.
