# dbwatch

[![ci](https://github.com/kanchingyg/dbwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/dbwatch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40kanchingyg%2Fdbwatch/latest?label=npm)](https://www.npmjs.com/package/@kanchingyg/dbwatch)
[![JSR](https://jsr.io/badges/@kanchingyg/dbwatch)](https://jsr.io/@kanchingyg/dbwatch)
[![JSR Score](https://jsr.io/badges/@kanchingyg/dbwatch/score)](https://jsr.io/@kanchingyg/dbwatch/score)
[![Runtime](https://img.shields.io/badge/runtime-Node_%7C_Bun_%7C_Deno-f9f1e1)](https://github.com/kanchingyg/dbwatch)
[![license](https://img.shields.io/github/license/kanchingyg/dbwatch)](https://github.com/kanchingyg/dbwatch/blob/HEAD/LICENSE)
[![npm](https://img.shields.io/npm/v/dbwatch)](https://www.npmjs.com/package/@kanchingyg/dbwatch)
[![JSR](https://jsr.io/badges/@kanchingyg/dbwatch)](https://jsr.io/@kanchingyg/dbwatch)
[![Bun](https://img.shields.io/badge/runtime-Node_%7C_Bun-f9f1e1)](https://github.com/kanchingyg/dbwatch)
[![license](https://img.shields.io/github/license/kanchingyg/dbwatch)](https://github.com/kanchingyg/dbwatch/blob/HEAD/LICENSE)

**One line:** `npx @kanchingyg/dbwatch sqlite:./app.db -- npm test` (or `bunx @kanchingyg/dbwatch sqlite:./app.db -- bun test`): git-style SQLite/D1 row diff around any command with instant `--revert`.

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/@kanchingyg/dbwatch):

```bash
bunx @kanchingyg/dbwatch sqlite:./local.db -- npm test
npx @kanchingyg/dbwatch sqlite:./local.db -- npm test

# or install in your project / globally
bun add -d @kanchingyg/dbwatch
npm i -D @kanchingyg/dbwatch
```

[JSR](https://jsr.io/@kanchingyg/dbwatch):

```bash
bunx jsr add @kanchingyg/dbwatch
npx jsr add @kanchingyg/dbwatch
```

## Quick start

```bash
npx @kanchingyg/dbwatch sqlite:./local.db -- npm test
bunx @kanchingyg/dbwatch sqlite:./local.db -- bun test
npx @kanchingyg/dbwatch sqlite:./local.db --revert --allow-write -- npm test
npx @kanchingyg/dbwatch --mcp
```

## MCP tools

| Tool | Purpose |
| --- | --- |
| `run_with_db_diff` | Wrap a command; returns exit code + compact row diff (`--allow-write`; `--dry-run` simulates) |
| `revert_last_diff` | Apply inverse SQL (`--allow-write`; `--dry-run` previews SQL) |
| `explain_side_effects` | Two-line local summary via Ollama / OpenAI-compatible API |

Add to Cursor or Claude Code:

```json
{
  "mcpServers": {
    "dbwatch": {
      "command": "npx",
      "args": ["-y", "@kanchingyg/dbwatch", "--mcp"]
    }
  }
}
```

## Local models

```bash
npx @kanchingyg/dbwatch sqlite:./app.db --explain --model ollama/qwen2.5-coder:7b
```

Point `baseUrl` in MCP `explain_side_effects` to LM Studio or vLLM (`http://127.0.0.1:1234`).

## Supported DSNs

- `sqlite:./path/to.db` or `file:./path/to.db`
- `d1:./local-d1.sqlite` (local Cloudflare D1 SQLite file)
- Postgres DSN parsing is reserved; use SQLite/D1 for zero-config local diffs today.

## MCP Tools Reference

| Tool | Mutates | Description |
| --- | --- | --- |
| `run_with_db_diff` | `true` | Snapshot SQLite/D1 tables, execute a child command, and return exit status plus row-level INSERT/UPDATE/DELETE diffs (requires `--allow-write`). |
| `revert_last_diff` | `true` | Execute inverse SQL statements from the most recent captured diff to restore prior table state (requires `--allow-write`). |
| `explain_side_effects` | `false` | Summarize captured row mutations in two lines via a local Ollama or OpenAI-compatible model. |

## Editor and Agent Integration

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "dbwatch": {
      "command": "npx",
      "args": ["-y", "@kanchingyg/dbwatch", "--mcp"]
    }
  }
}
```

### Claude Code CLI

```bash
claude mcp add dbwatch -- npx -y @kanchingyg/dbwatch --mcp
```

### Programmatic Usage (JSR / TypeScript)

```ts
import * as bridge from "jsr:@kanchingyg/dbwatch/bridge";
```

## Runtime Safety and Guardrails

- **Stdio frame isolation**: When `--mcp` is active, `hijackStdoutForMcp()` redirects accidental `console.log` calls to `stderr` so JSON-RPC 2.0 frames on `stdout` never corrupt.
- **Read-only by default**: Mutating tools (`mutates: true`) are blocked in `--dry-run` mode and require explicit `--allow-write` authorization.
- **Loop breaker**: Repeated identical `(toolName, args)` invocations are hashed with SHA-256 and halted after 3 consecutive repeats to prevent runaway agent loops.
- **Context budget truncation**: Tool outputs are middle-truncated (`60%` head / `40%` tail) scaled to the probed local model `n_ctx` (Ollama `/api/show`, llama.cpp `/props`, vLLM `/v1/models`).
- **Secret redaction and path normalization**: AWS keys (`AKIA*`, `ASIA*`), bearer tokens, and `sk-*` keys are scrubbed before returning tool output, and Windows drive paths (`C:\...`) translate cleanly to `/mnt/c/...` when WSL mode is enabled.

## License

[MIT](./LICENSE)
