# Repository Guidelines

## Project Structure & Module Organization

- `src/`: TypeScript source for the ACP proxy runtime, sandbox providers, and WebSocket client.
- `src/**.test.ts`: Vitest unit and integration tests colocated with code.
- `scripts/`: Node scripts used by e2e/self-check workflows.
- `acp-protocol/`: ACP protocol assets and references used by the proxy.
- `agent-images/`: Local container/VM image artifacts or build helpers.
- `config.toml.example`: Copy to `config.toml` for runtime configuration.

## Build, Test, and Development Commands

Run from the repo root:

- `pnpm install`: install dependencies.
- `pnpm dev`: run the proxy in watch mode via `tsx` (uses `config.toml`).
- `pnpm build`: compile TypeScript to `dist/`.
- `pnpm start`: start the compiled proxy with `config.toml`.
- `pnpm lint`: ESLint for the repo.
- `pnpm typecheck`: TypeScript type-only check.
- `pnpm test`: Vitest test run.
- `pnpm test:coverage`: coverage report.
- `pnpm test:docker`, `pnpm test:boxlite`, `pnpm test:index-e2e`: optional e2e/self-checks.

## Coding Style & Naming Conventions

- TypeScript ESM (`"type": "module"`), 2-space indentation.
- Match local formatting and keep diffs minimal.
- Files use `camelCase.ts` for modules; tests use `*.test.ts`.
- Linting via `eslint.config.js`.

## Testing Guidelines

- Framework: Vitest.
- Tests are colocated in `src/` and named `*.test.ts`.
- Run focused tests with `pnpm test -- -t "pattern"`.
- Optional e2e checks may require BoxLite or container runtimes.

## Commit & Pull Request Guidelines

- Use Conventional Commits (e.g., `feat:`, `fix:`, `docs:`).
- PRs should include: clear description, linked issue/run, test results, and notes on sandbox provider/runtime if relevant.

## Security & Configuration Tips

- Do not commit secrets. Use `config.toml` or environment variables for tokens.
- Required config includes `orchestrator_url`, `sandbox.provider`, and `sandbox.image`.
