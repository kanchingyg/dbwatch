#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import {
  dispatchMcpMessage,
  hijackStdoutForMcp,
  normalizePathsDeep,
  probeNCtx,
  redactSecrets,
  setGuards,
  startMcpServer,
  truncateToolOutput,
  type McpToolDef,
} from "./bridge.js";
import { assertPostgresSupported, isPostgresDsn } from "./pg-tracker.js";
import {
  getDiffRecord,
  listDiffIds,
  revertDiff,
  runWithSqliteDiff,
} from "./sqlite-tracker.js";

/** Constant `DBWATCH_TOOLS` defining dbwatch tools. */
export const DBWATCH_TOOLS: McpToolDef[] = [
  {
    name: "run_with_db_diff",
    description: "Run a shell command and return DB row diff JSON.",
    inputSchema: {
      type: "object",
      properties: {
        dsn: { type: "string" },
        cmd: { type: "array", items: { type: "string" } },
      },
      required: ["dsn", "cmd"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    mutates: true,
  },
  {
    name: "revert_last_diff",
    description: "Execute inverse SQL for a captured diff id.",
    inputSchema: {
      type: "object",
      properties: { diffId: { type: "string" } },
      required: ["diffId"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    mutates: true,
  },
  {
    name: "explain_side_effects",
    description: "Summarize whether a diff matches expected test impact.",
    inputSchema: {
      type: "object",
      properties: {
        diffId: { type: "string" },
        model: { type: "string" },
        baseUrl: { type: "string" },
      },
      required: ["diffId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

/** Executes `parseModelRef` to parse model ref in `dbwatch`. */
export function parseModelRef(model?: string): { baseUrl: string; model: string } {
  if (!model) {
    return { baseUrl: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b" };
  }
  if (model.includes("/")) {
    const [host, name] = model.split("/", 2);
    if (host === "ollama") {
      return { baseUrl: "http://127.0.0.1:11434", model: name };
    }
    return { baseUrl: `https://api.${host}.com/v1`, model: name };
  }
  return { baseUrl: "http://127.0.0.1:11434", model };
}

/** Executes `explainSideEffects` to explain side effects in `dbwatch`. */
export async function explainSideEffects(
  diffId: string,
  modelRef?: string,
  baseUrlOverride?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const rec = getDiffRecord(diffId);
  if (!rec) throw new Error(`Unknown diffId: ${diffId}`);
  const { baseUrl, model } = parseModelRef(modelRef);
  const url = baseUrlOverride ?? baseUrl;
  const { nCtx } = await probeNCtx(url, fetchImpl);
  const body = truncateToolOutput(
    redactSecrets(JSON.stringify({ lines: rec.lines, changes: rec.changes })),
    nCtx,
  );
  const endpoint = `${url.replace(/\/$/, "")}/v1/chat/completions`;
  const res = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: `In two lines, say if this DB diff matches a typical test mutation:\n${body}`,
        },
      ],
      stream: false,
    }),
  });
  if (!res.ok) {
    return `Local model unavailable (${res.status}). Diff lines:\n${rec.lines.join("\n")}`;
  }
  const j = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return j.choices?.[0]?.message?.content?.trim() ?? rec.lines.join("\n");
}

function mcpHandlers(): Record<string, (args: Record<string, unknown>) => Promise<unknown>> {
  return {
    run_with_db_diff: async (args) => {
      const dsn = String(args.dsn);
      assertPostgresSupported(dsn);
      const cmd = (args.cmd as string[]) ?? [];
      const result = runWithSqliteDiff(dsn, cmd, { env: { DBWATCH_MCP: "1" } });
      return {
        exitCode: result.exitCode,
        diffId: result.diffId,
        changes: result.changes,
        lines: result.lines,
      };
    },
    revert_last_diff: async (args) => {
      const diffId = String(args.diffId);
      const dry = !process.argv.includes("--allow-write");
      return revertDiff(diffId, dry);
    },
    explain_side_effects: async (args) => {
      const text = await explainSideEffects(
        String(args.diffId),
        args.model as string | undefined,
        args.baseUrl as string | undefined,
      );
      return { summary: text };
    },
  };
}

/** Executes `runMcpMode` to run mcp mode in `dbwatch`. */
export function runMcpMode(): void {
  hijackStdoutForMcp();
  if (process.argv.includes("--allow-write")) setGuards({ allowWrite: true });
  if (process.argv.includes("--dry-run")) setGuards({ dryRun: true });
  startMcpServer({
    tools: DBWATCH_TOOLS,
    handlers: mcpHandlers(),
  });
}

/** Executes `runCli` to run cli in `dbwatch`. */
export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes("--mcp")) {
    runMcpMode();
    return 0;
  }

  const revert = argv.includes("--revert");
  const explain = argv.includes("--explain");
  const dash = argv.indexOf("--");
  if (dash < 1) {
    process.stderr.write(
      "Usage: dbwatch <dsn> [--revert] [--explain --model ollama/name] -- <command...>\n       dbwatch --mcp\n",
    );
    return 2;
  }

  const dsn = argv[0];
  assertPostgresSupported(dsn);
  if (isPostgresDsn(dsn)) return 2;

  const cmd = argv.slice(dash + 1);
  if (cmd.length === 0) return 2;

  if (explain) {
    const modelIdx = argv.indexOf("--model");
    const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;
    const ids = listDiffIds();
    const last = ids[ids.length - 1];
    if (!last) {
      process.stderr.write("No diff to explain.\n");
      return 1;
    }
    const text = await explainSideEffects(last, model);
    process.stdout.write(text + "\n");
    return 0;
  }

  if (revert) {
    const ids = listDiffIds();
    const last = ids[ids.length - 1];
    if (last) {
      const dry = !argv.includes("--allow-write");
      revertDiff(last, dry);
    }
  }

  const result = runWithSqliteDiff(dsn, cmd);
  for (const line of result.lines) {
    process.stderr.write(line + "\n");
  }
  return result.exitCode;
}

const isMain = process.argv[1]?.includes("cli") || process.argv[1]?.endsWith("dbwatch");
if (isMain) {
  void runCli(process.argv.slice(2)).then((code) => {
    if (!process.argv.includes("--mcp")) process.exit(code);
  });
}

export { dispatchMcpMessage, normalizePathsDeep };
