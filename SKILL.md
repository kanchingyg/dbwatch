---
name: dbwatch
description: Wrap tests/commands with live SQLite/D1 row diffs and MCP rollback tools.
---

# dbwatch

Run `npx dbwatch <dsn> -- <command>` before trusting a migration or test.

- MCP: `npx dbwatch --mcp` exposes `run_with_db_diff`, `revert_last_diff`, `explain_side_effects`.
- Destructive rollback needs `--allow-write` (default is read-only for `revert_last_diff`).
- For local reasoning on diffs, pass `--model ollama/<name>` or an OpenAI-compatible `baseUrl`.
