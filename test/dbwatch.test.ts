import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hijackStdoutForMcp,
  jsonRpcFrameLog,
  dispatchMcpMessage,
  setGuards,
  resetLoopBreaker,
  checkLoopBreaker,
  guardMutatingTool,
  windowsToWsl,
  wslToWindows,
  normalizeEmbedBatch,
  floatArrayToBase64,
  base64ToFloatArray,
  mrlSlice,
  assertDimensionFingerprint,
  readEmbedLock,
  writeEmbedLock,
  EMBED_LOCK,
  headTailTruncate,
  buildRecencyAnchor,
  anchorPromptTail,
  StreamToolJsonAbort,
  parseDirtyToolCall,
  applyReasoningContentPolicy,
  createReasoningState,
  sanitizeRequestBody,
  normalizeToolChoice,
  detectProvider,
} from "../src/bridge.js";
import { DBWATCH_TOOLS, explainSideEffects, parseModelRef } from "../src/cli.js";
import {
  captureSnapshot,
  clearDiffStore,
  getDiffRecord,
  openSqlite,
  resolveSqlitePath,
  runScriptOnDb,
  runWithSqliteMutation,
  revertDiff,
} from "../src/sqlite-tracker.js";
import { diffSnapshots, formatDiffLine } from "../src/differ.js";

describe("sqlite diff + revert", () => {
  let dir: string;
  let dsn: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "dbwatch-"));
    process.chdir(dir);
    dsn = "sqlite:./app.db";
    const db = openSqlite(dsn);
    runScriptOnDb(
      db,
      `CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT);
       INSERT INTO orders (id, status) VALUES (1, 'new'), (2, 'new');`,
    );
    db.close();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists diff json and reloads after cache clear", () => {
    const result = runWithSqliteMutation(dsn, (db) => {
      db.exec("UPDATE orders SET status='paid' WHERE id=1");
    });
    const persisted = join(dir, ".dbwatch", "diffs", `${result.diffId}.json`);
    expect(existsSync(persisted)).toBe(true);
    clearDiffStore();
    const reloaded = getDiffRecord(result.diffId, dsn);
    expect(reloaded?.changes.length).toBe(result.changes.length);
  });

  it("rejects sqlite paths outside cwd", () => {
    expect(() => resolveSqlitePath(`sqlite:${join(tmpdir(), "escape.db")}`)).toThrow(/under cwd/);
  });

  it("captures UPDATE diff and reverts to baseline", () => {
    const beforeDb = openSqlite(dsn);
    const before = captureSnapshot(beforeDb);
    beforeDb.close();

    const result = runWithSqliteMutation(dsn, (db) => {
      db.exec("UPDATE orders SET status='paid' WHERE id=1");
    });

    expect(result.changes.some((c) => c.op === "update")).toBe(true);
    expect(result.lines.some((l) => l.startsWith("~ UPDATE"))).toBe(true);

    revertDiff(result.diffId, false);

    const afterDb = openSqlite(dsn);
    const after = captureSnapshot(afterDb);
    afterDb.close();
    const drift = diffSnapshots(before.snap, after.snap, before.pkCols);
    expect(drift.length).toBe(0);
  });

  it("reports INSERT and UPDATE lines for seed script", () => {
    const empty = mkdtempSync(join(tmpdir(), "dbwatch-empty-"));
    const prev = process.cwd();
    process.chdir(empty);
    const emptyDsn = "sqlite:./fresh.db";
    runWithSqliteMutation(emptyDsn, (db) => {
      db.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)");
      db.exec("INSERT INTO orders VALUES (1,'new')");
    });
    const result = runWithSqliteMutation(emptyDsn, (db) => {
      db.exec("INSERT INTO orders VALUES (2,'new')");
      db.exec("UPDATE orders SET status='paid' WHERE id=1");
    });
    expect(result.lines.some((l) => l.startsWith("+ INSERT"))).toBe(true);
    expect(result.lines.some((l) => l.startsWith("~ UPDATE"))).toBe(true);
    process.chdir(prev);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("MCP JSON-RPC", () => {
  it("handshake initialize and tools/list", () => {
    jsonRpcFrameLog.length = 0;
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { tools: [{ name: "run_with_db_diff", description: "Run cmd diff.", inputSchema: { type: "object", properties: {} } }] },
    );
    dispatchMcpMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, {
      tools: [{ name: "run_with_db_diff", description: "Run cmd diff.", inputSchema: { type: "object", properties: {} } }],
    });
    const init = JSON.parse(jsonRpcFrameLog[0].trim());
    expect(init.result.serverInfo.name).toBe("dbwatch");
    const list = JSON.parse(jsonRpcFrameLog[1].trim());
    expect(list.result.tools[0].name).toBe("run_with_db_diff");
  });
});

describe("MCP Blindaje 4", () => {
  let stderrChunks: string[];

  beforeEach(() => {
    stderrChunks = [];
    jsonRpcFrameLog.length = 0;
    const nativeStderr = process.stderr.write.bind(process.stderr);
    hijackStdoutForMcp();
    process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
      stderrChunks.push(String(chunk));
      return nativeStderr(chunk as Buffer, ...(args as [BufferEncoding?, (err?: Error) => void?]));
    }) as typeof process.stderr.write;
  });

  it("routes noise to stderr and keeps JSON-RPC clean", async () => {
    const tool = {
      name: "echo_path",
      description: "echo",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    };
    dispatchMcpMessage(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo_path", arguments: { path: "D:\\proj\\foo.ts" } } },
      {
        tools: [tool],
        pathToWsl: true,
        handlers: {
          echo_path: async (args) => {
            process.stdout.write("NOISE\n");
            return args;
          },
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrChunks.join("")).toContain("NOISE");
    const frame = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(frame.result.content[0].text).toContain("/mnt/d/proj/foo.ts");
  });
});

describe("Blindaje 1", () => {
  beforeEach(() => {
    resetLoopBreaker();
    setGuards({ allowWrite: false, dryRun: false });
  });

  it("blocks mutating tools without allow-write", () => {
    const g = guardMutatingTool({
      name: "revert_last_diff",
      description: "revert",
      inputSchema: { type: "object", properties: {} },
      mutates: true,
    });
    expect(g.blocked).toBe(true);
  });

  it("blocks run_with_db_diff MCP call without allow-write", async () => {
    jsonRpcFrameLog.length = 0;
    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "run_with_db_diff",
          arguments: { dsn: "sqlite:./app.db", cmd: ["node", "-e", "0"] },
        },
      },
      { tools: DBWATCH_TOOLS, handlers: {} },
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(frame.result.isError).toBe(true);
    expect(frame.result.content[0].text).toMatch(/allow-write/);
  });

  it("dry-run simulates mutating tools but not read-only explain", async () => {
    setGuards({ allowWrite: false, dryRun: true });
    jsonRpcFrameLog.length = 0;
    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "run_with_db_diff", arguments: { dsn: "sqlite:./x.db", cmd: ["true"] } },
      },
      { tools: DBWATCH_TOOLS, handlers: {} },
    );
    await new Promise((r) => setTimeout(r, 20));
    const mutating = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(mutating.result.content[0].text).toMatch(/\[dry-run\]/);

    jsonRpcFrameLog.length = 0;
    dispatchMcpMessage(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "explain_side_effects", arguments: { diffId: "diff_test" } },
      },
      {
        tools: DBWATCH_TOOLS,
        handlers: {
          explain_side_effects: async () => ({ summary: "ok" }),
        },
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    const readOnly = JSON.parse(jsonRpcFrameLog[jsonRpcFrameLog.length - 1].trim());
    expect(readOnly.result.content[0].text).toContain("ok");
  });

  it("loop breaker on third identical call", () => {
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toBeNull();
    expect(checkLoopBreaker("t", { a: 1 })).toMatch(/LOOP_BREAKER/);
  });
});

describe("Blindaje 2", () => {
  it("head+tail truncation", () => {
    const long = "H".repeat(200) + "T".repeat(200);
    const out = headTailTruncate(long, 200);
    expect(out).toContain("TRUNCATED");
  });

  it("recency anchor at end of prompt", () => {
    const anchor = buildRecencyAnchor([{ name: "run_with_db_diff", summary: "Run diff" }]);
    const prompt = "SYSTEM\n...\nASSISTANT:";
    const anchored = anchorPromptTail(prompt, anchor);
    expect(anchored.indexOf(anchor)).toBeLessThan(anchored.lastIndexOf("ASSISTANT:"));
  });
});

describe("Blindaje 5", () => {
  it("reasoning_content replay vs strip", () => {
    let state = createReasoningState();
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", reasoning_content: "think", tool_calls: [{}] },
      { role: "tool", content: "{}" },
    ];
    const r1 = applyReasoningContentPolicy(msgs, state);
    expect(r1.messages[1].reasoning_content).toBe("think");
    state = r1.state;
    const msgs2 = [
      ...msgs,
      { role: "user", content: "next" },
      { role: "assistant", content: "done", reasoning_content: "old" },
    ];
    const r2 = applyReasoningContentPolicy(msgs2, state);
    expect(r2.messages[1].reasoning_content).toBeUndefined();
  });

  it("parses Kimi GLM Qwen and IQ1 broken JSON", () => {
    const kimi =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.run:0<|tool_call_argument_begin|>{"target":"x"}<|tool_call_end|><|tool_calls_section_end|>';
    expect(parseDirtyToolCall(kimi)?.name).toBe("run");
    const glm =
      '<|tool_call_begin|>run_check<|tool_call_sep|>{"target":"a"}<|tool_call_end|>';
    expect(parseDirtyToolCall(glm)?.arguments.target).toBe("a");
    const qwen = "✿FUNCTION✿: run_check\n✿ARGS✿: {'target': 'z'}\n";
    expect(parseDirtyToolCall(qwen)?.name).toBe("run_check");
    const iq = "{'cmd': 'ls'}";
    expect(parseDirtyToolCall(iq)?.arguments).toEqual({ cmd: "ls" });
  });

  it("stream abort when tool JSON closes", () => {
    const guard = new StreamToolJsonAbort();
    expect(guard.feed('<tool_call>{"name":"t","arguments":{')).toBe(false);
    expect(guard.feed("}}")).toBe(true);
  });

  it("provider sanitization", () => {
    const body = sanitizeRequestBody(
      { temperature: 0.2, top_p: 0.9, model: "deepseek-reasoner" },
      "deepseek-reasoner",
    );
    expect(body.temperature).toBeUndefined();
    expect(normalizeToolChoice("required", detectProvider("https://dashscope.aliyuncs.com"))).toBe(
      "auto",
    );
  });
});

describe("Blindaje 3 embed", () => {
  it("splits 60 into batches of 10", async () => {
    const calls: number[] = [];
    const upstream = {
      name: "dashscope",
      maxBatch: 10,
      embed: async (input: string[]) => {
        calls.push(input.length);
        return input.map(() => [1, 0, 0]);
      },
    };
    const inputs = Array.from({ length: 60 }, (_, i) => `text-${i}`);
    await normalizeEmbedBatch(inputs, { upstream, model: "text-embedding-v3", dimensions: 3 });
    expect(calls.length).toBe(6);
  });

  it("float base64 roundtrip and MRL L2", () => {
    const vec = [3, 4];
    const back = base64ToFloatArray(floatArrayToBase64(vec));
    expect(back[0]).toBeCloseTo(3);
    const sliced = mrlSlice([3, 4, 0], 2);
    expect(Math.hypot(sliced[0], sliced[1])).toBeCloseTo(1);
  });

  it("rejects dimension fingerprint mismatch", () => {
    expect(() => assertDimensionFingerprint({ provider: "x", model: "m", dimension: 1024 }, 768)).toThrow(
      /fingerprint/,
    );
  });

  it("writes embed lock file", () => {
    const d = mkdtempSync(join(tmpdir(), "dbwatch-embed-"));
    writeEmbedLock(d, { provider: "p", model: "m", dimension: 1024 });
    expect(readEmbedLock(d)?.dimension).toBe(1024);
    expect(existsSync(join(d, EMBED_LOCK))).toBe(true);
    rmSync(d, { recursive: true });
  });
});

describe("Ollama / OpenAI-compat explain", () => {
  it("parseModelRef defaults to local ollama", () => {
    expect(parseModelRef("ollama/qwen2.5-coder:7b").model).toBe("qwen2.5-coder:7b");
  });

  it("explain uses fetch mock when model responds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dbwatch-explain-"));
    const prev = process.cwd();
    process.chdir(dir);
    const dsn = "sqlite:./e.db";
    const db = openSqlite(dsn);
    runScriptOnDb(db, "CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t VALUES (1);");
    db.close();
    const run = runWithSqliteMutation(dsn, (db) => {
      db.exec("INSERT INTO t VALUES (2)");
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "Looks like a test insert." } }] }),
    })) as typeof fetch;
    const summary = await explainSideEffects(
      run.diffId,
      "ollama/qwen2.5-coder:7b",
      "http://127.0.0.1:11434",
      fetchMock,
    );
    expect(summary).toContain("insert");
    process.chdir(prev);
    rmSync(dir, { recursive: true });
  });
});

describe("path normalize", () => {
  it("translates windows and wsl", () => {
    expect(windowsToWsl("D:\\proj\\foo.ts")).toBe("/mnt/d/proj/foo.ts");
    expect(wslToWindows("/mnt/d/proj/foo.ts")).toBe("D:\\proj\\foo.ts");
  });
});
