# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm -r build

# Build a single package
pnpm --filter @db-mirror/core build
pnpm --filter @db-mirror/cli build
pnpm --filter @db-mirror/desktop build

# Run all tests
pnpm -r test

# Run tests for a single package
pnpm --filter @db-mirror/core test

# Typecheck all packages
pnpm -r typecheck

# Desktop dev server (Vite + Electron)
pnpm --filter @db-mirror/desktop dev
pnpm --filter @db-mirror/desktop start

# Package desktop app (DMG/NSIS/AppImage)
pnpm --filter @db-mirror/desktop package

# Run CLI directly
node packages/cli/bin/db-mirror.js <command>
```

## Architecture

pnpm workspace monorepo with three packages:

**`packages/core`** — pure ESM library, no Node-specific I/O assumptions except `node:crypto` and `mysql2`.
- `vault/` — AES-256-GCM + scrypt encrypted credential store (`vault.ts`, `crypto.ts`, `types.ts`)
- `connection/` — `mysql2` pool wrapper; builds config from a vault profile, handles K8s port-forward lifecycle
- `schema-diff/` — `introspect.ts` reads tables/indexes/views/procedures/triggers via `information_schema`; `diff.ts` produces ALTER/CREATE/DROP statements
- `data-diff/` — row-level diff over primary keys → INSERT/UPDATE/DELETE
- `dump/` — `mysqldump` child-process wrapper + streaming restore
- `sync-plan/` — serialisable `SyncPlan` object that combines schema + data diffs
- `filters/` — glob include/exclude for table names (uses `micromatch`)
- `k8s/` — `@kubernetes/client-node` port-forward to `127.0.0.1` with a random port

**`packages/cli`** — Commander-based CLI (`db-mirror`). Each sub-command lives in `src/commands/`. Passphrase is resolved from `DB_MIRROR_PASSPHRASE` env, `--passphrase-file`, or an interactive prompt (`passphrase.ts`). Default vault path resolves via `paths.ts`.

**`packages/desktop`** — Electron + React. Two build steps: `tsc` compiles the main process (`tsconfig.main.json`), Vite compiles the renderer (`tsconfig.renderer.json`). IPC channels are typed in `src/shared/ipc-channels.ts`; the main process handlers live in `src/main/ipc.ts`; the renderer side in `src/renderer/ipc.ts`. Views: `UnlockView`, `ConnectionsView` (with `ProfileForm`), `WorkbenchView`.

## Key conventions

- All packages are ESM (`"type": "module"`); imports must use `.js` extensions even for `.ts` source files.
- `core` has no dependency on `cli` or `desktop`; `cli` and `desktop` both depend on `core` via `workspace:*`.
- Tests use **vitest** (`vitest run`). Test files are under `packages/*/test/`.
- TypeScript is compiled with `tsc` (no bundler) for `core` and `cli`; Vite handles the renderer only.
- Destructive operations (Apply, Full-Overwrite) require the user to type the target profile name as confirmation — enforce this in both CLI and UI.
