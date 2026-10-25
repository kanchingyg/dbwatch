# dbwatch

[![ci](https://github.com/kanchingyg/dbwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/kanchingyg/dbwatch/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dbwatch)](https://www.npmjs.com/package/dbwatch)
[![JSR](https://jsr.io/badges/@kanchingyg/dbwatch)](https://jsr.io/@kanchingyg/dbwatch)
[![Bun](https://img.shields.io/badge/runtime-Node_%7C_Bun-f9f1e1)](https://github.com/kanchingyg/dbwatch)
[![license](https://img.shields.io/github/license/kanchingyg/dbwatch)](https://github.com/kanchingyg/dbwatch/blob/HEAD/LICENSE)

**One line:** `npx dbwatch sqlite:./app.db -- npm test` (or `bunx dbwatch sqlite:./app.db -- bun test`): git-style SQLite/D1 row diff around any command with instant `--revert`.

## Install

[Bun](https://bun.sh) / [npm](https://www.npmjs.com/package/dbwatch):

```bash
bunx dbwatch sqlite:./local.db -- npm test
npx dbwatch sqlite:./local.db -- npm test

# or install in your project / globally
bun add -d dbwatch
npm i -D dbwatch
```

[JSR](https://jsr.io/@kanchingyg/dbwatch):

```bash
bunx jsr add @kanchingyg/dbwatch
npx jsr add @kanchingyg/dbwatch
```

## Quick start

```bash
npx dbwatch sqlite:./local.db -- npm test
bunx dbwatch sqlite:./local.db -- bun test
npx dbwatch sqlite:./local.db --revert --allow-write -- npm test
npx dbwatch --mcp
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
      "args": ["-y", "dbwatch", "--mcp"]
    }
  }
}
```

## Local models

```bash
npx dbwatch sqlite:./app.db --explain --model ollama/qwen2.5-coder:7b
```

Point `baseUrl` in MCP `explain_side_effects` to LM Studio or vLLM (`http://127.0.0.1:1234`).

## Supported DSNs

- `sqlite:./path/to.db` or `file:./path/to.db`
- `d1:./local-d1.sqlite` (local Cloudflare D1 SQLite file)
- Postgres DSN parsing is reserved; use SQLite/D1 for zero-config local diffs today.

## License

[MIT](./LICENSE)
