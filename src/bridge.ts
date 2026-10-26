#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Configuration and data shape for `McpToolDef` (mcp tool def). */
export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  mutates?: boolean;
};

/** Configuration and data shape for `GuardOptions` (guard options). */
export type GuardOptions = {
  allowWrite?: boolean;
  dryRun?: boolean;
};

let allowWrite = false;
let dryRun = false;

/** Executes `setGuards` to set guards in `dbwatch`. */
export function setGuards(opts: GuardOptions): void {
  allowWrite = Boolean(opts.allowWrite);
  dryRun = Boolean(opts.dryRun);
}

/** Executes `canonicalizeJson` to canonicalize json in `dbwatch`. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`).join(",")}}`;
}

/** Executes `loopBreakerHash` to loop breaker hash in `dbwatch`. */
export function loopBreakerHash(toolName: string, args: unknown): string {
  return createHash("sha256")
    .update(`${toolName}:${canonicalizeJson(args)}`)
    .digest("hex");
}

const loopState = { lastHash: "", repeatCount: 0 };

/** Executes `resetLoopBreaker` to reset loop breaker in `dbwatch`. */
export function resetLoopBreaker(): void {
  loopState.lastHash = "";
  loopState.repeatCount = 0;
}

/** Executes `checkLoopBreaker` to check loop breaker in `dbwatch`. */
export function checkLoopBreaker(toolName: string, args: unknown): string | null {
  const h = loopBreakerHash(toolName, args);
  if (h === loopState.lastHash) {
    loopState.repeatCount++;
  } else {
    loopState.lastHash = h;
    loopState.repeatCount = 1;
  }
  if (loopState.repeatCount >= 3) {
    return "LOOP_BREAKER: Identical tool call repeated 2 times consecutively. Stop calling tools and return your final synthesis.";
  }
  return null;
}

/** Executes `guardMutatingTool` to guard mutating tool in `dbwatch`. */
export function guardMutatingTool(tool: McpToolDef): { blocked: boolean; reason?: string } {
  if (!tool.mutates) return { blocked: false };
  if (!allowWrite) {
    return {
      blocked: true,
      reason: "Read-only mode: pass --allow-write to enable mutating tools.",
    };
  }
  return { blocked: false };
}

const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;

/** Executes `windowsToWsl` to windows to wsl in `dbwatch`. */
export function windowsToWsl(p: string): string {
  const m = p.match(WIN_DRIVE_RE);
  if (!m) return p;
  const rest = m[2].replace(/\\/g, "/");
  return `/mnt/${m[1].toLowerCase()}/${rest}`;
}

/** Executes `wslToWindows` to wsl to windows in `dbwatch`. */
export function wslToWindows(p: string): string {
  const m = p.match(WSL_RE);
  if (!m) return p;
  const rest = m[2].replace(/\//g, "\\");
  return `${m[1].toUpperCase()}:\\${rest}`;
}

/** Executes `normalizePathsDeep` to normalize paths deep in `dbwatch`. */
export function normalizePathsDeep<T>(value: T, toWsl: boolean): T {
  if (typeof value === "string") {
    if (toWsl && WIN_DRIVE_RE.test(value)) return windowsToWsl(value) as T;
    if (!toWsl && WSL_RE.test(value)) return wslToWindows(value) as T;
    if (value.startsWith("file:///")) {
      const raw = value.slice(8).replace(/\//g, "\\");
      return (toWsl ? windowsToWsl(raw) : raw) as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizePathsDeep(v, toWsl)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizePathsDeep(v, toWsl);
    }
    return out as T;
  }
  return value;
}

let jsonRpcWrite: ((line: string) => void) | null = null;
let stdoutHijacked = false;

/** Executes `hijackStdoutForMcp` to hijack stdout for mcp in `dbwatch`. */
export function hijackStdoutForMcp(): void {
  if (stdoutHijacked) return;
  stdoutHijacked = true;
  const native = process.stdout.write.bind(process.stdout);
  jsonRpcWrite = (line: string) => {
    native(line);
  };
  process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    const str = typeof chunk === "string" ? chunk : Buffer.from(chunk as Buffer).toString();
    if (jsonRpcWrite && str.trim().startsWith("{") && str.includes('"jsonrpc"')) {
      return native(chunk as string, ...(args as []));
    }
    process.stderr.write(str);
    return true;
  }) as typeof process.stdout.write;
}

/** Constant `jsonRpcFrameLog` defining json rpc frame log. */
export const jsonRpcFrameLog: string[] = [];

/** Executes `writeJsonRpcFrame` to write json rpc frame in `dbwatch`. */
export function writeJsonRpcFrame(obj: object): void {
  const line = JSON.stringify(obj) + "\n";
  jsonRpcFrameLog.push(line);
  if (jsonRpcWrite) jsonRpcWrite(line);
  else process.stdout.write(line);
}

/** Configuration and data shape for `McpServerOptions` (mcp server options). */
export type McpServerOptions = {
  repoRoot?: string;
  tools?: McpToolDef[];
  handlers?: Record<string, (args: Record<string, unknown>) => Promise<unknown>>;
  pathToWsl?: boolean;
  nCtx?: number;
};

/** Executes `startMcpServer` to start mcp server in `dbwatch`. */
export function startMcpServer(opts: McpServerOptions = {}): void {
  hijackStdoutForMcp();
  const repoRoot = opts.repoRoot ?? process.cwd();
  const tools = opts.tools ?? [];
  const handlers = opts.handlers ?? {};
  const toWsl = opts.pathToWsl ?? process.env.DBWATCH_PATH_WSL === "1";

  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  let buffer = "";

  stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: {
        jsonrpc?: string;
        id?: number | string;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      dispatchMcpMessage(msg, { repoRoot, tools, handlers, pathToWsl: toWsl, nCtx: opts.nCtx });
    }
  });
}

/** Executes `dispatchMcpMessage` to dispatch mcp message in `dbwatch`. */
export function dispatchMcpMessage(
  msg: {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  },
  opts: McpServerOptions = {},
): void {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const tools = opts.tools ?? [];
  const handlers = opts.handlers ?? {};
  const toWsl = opts.pathToWsl ?? process.env.DBWATCH_PATH_WSL === "1";
  const nCtx = opts.nCtx ?? DEFAULT_N_CTX;
  handleMessage(msg, tools, handlers, toWsl, nCtx);
}

function handleMessage(
  msg: {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
  },
  tools: McpToolDef[],
  handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>>,
  toWsl: boolean,
  nCtx: number,
): void {
  const { id, method, params } = msg;
  if (method === "initialize") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "dbwatch", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      result: {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      },
    });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name as string;
    const args = normalizePathsDeep(
      (params?.arguments as Record<string, unknown>) ?? {},
      toWsl,
    );
    const tool = tools.find((t) => t.name === name);
    const loopErr = checkLoopBreaker(name, args);
    if (loopErr) {
      writeJsonRpcFrame({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: loopErr }], isError: true },
      });
      return;
    }
    if (tool) {
      if (dryRun && tool.mutates) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: `[dry-run] Would call ${name} with ${canonicalizeJson(args)}`,
              },
            ],
          },
        });
        return;
      }
      const guard = guardMutatingTool(tool);
      if (guard.blocked) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: guard.reason ?? "blocked" }],
            isError: true,
          },
        });
        return;
      }
    }
    const handler = handlers[name];
    void (async () => {
      try {
        let result: unknown;
        if (handler) {
          result = await handler(args);
        } else {
          result = { ok: true, tool: name, args };
        }
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: finalizeMcpToolText(text, { nCtx, toWsl }) }],
          },
        });
      } catch (e) {
        writeJsonRpcFrame({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: finalizeMcpToolText(String(e), { nCtx, toWsl }) }],
            isError: true,
          },
        });
      }
    })();
    return;
  }
  if (id !== undefined) {
    writeJsonRpcFrame({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

/** Constant `EMBED_LOCK` defining embed lock. */
export const EMBED_LOCK = ".dbwatch-embed-lock.json";
/** Constant `KNOWN_DIMENSIONS` defining known dimensions. */
export const KNOWN_DIMENSIONS = [384, 768, 1024, 1536, 2560, 3072, 4096] as const;

/** Configuration and data shape for `EmbedLock` (embed lock). */
export type EmbedLock = {
  provider: string;
  model: string;
  dimension: number;
};

/** Executes `readEmbedLock` to read embed lock in `dbwatch`. */
export function readEmbedLock(repoRoot: string): EmbedLock | null {
  const p = join(repoRoot, EMBED_LOCK);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as EmbedLock;
}

/** Executes `writeEmbedLock` to write embed lock in `dbwatch`. */
export function writeEmbedLock(repoRoot: string, lock: EmbedLock): void {
  writeFileSync(join(repoRoot, EMBED_LOCK), JSON.stringify(lock, null, 2));
}

/** Executes `assertDimensionFingerprint` to assert dimension fingerprint in `dbwatch`. */
export function assertDimensionFingerprint(
  lock: EmbedLock | null,
  dim: number,
): void {
  if (!lock) return;
  if (lock.dimension !== dim) {
    throw new Error(
      `Dimension fingerprint mismatch: lock expects ${lock.dimension}, got ${dim}`,
    );
  }
}

/** Executes `l2Normalize` to l2 normalize in `dbwatch`. */
export function l2Normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum) || 1;
  return vec.map((v) => v / norm);
}

/** Executes `mrlSlice` to mrl slice in `dbwatch`. */
export function mrlSlice(vec: number[], dimensions: number): number[] {
  const sliced = vec.slice(0, dimensions);
  return l2Normalize(sliced);
}

/** Executes `floatArrayToBase64` to float array to base64 in `dbwatch`. */
export function floatArrayToBase64(vec: number[]): string {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf.toString("base64");
}

/** Executes `base64ToFloatArray` to base64 to float array in `dbwatch`. */
export function base64ToFloatArray(b64: string): number[] {
  const buf = Buffer.from(b64, "base64");
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    out.push(buf.readFloatLE(i));
  }
  return out;
}

/** Configuration and data shape for `EmbedUpstream` (embed upstream). */
export type EmbedUpstream = {
  name: string;
  maxBatch: number;
  embed: (input: string[], model: string, dimensions?: number) => Promise<number[][]>;
};

/** Executes `chunkArray` to chunk array in `dbwatch`. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Executes `normalizeEmbedBatch` to normalize embed batch in `dbwatch`. */
export async function normalizeEmbedBatch(
  inputs: string[],
  options: {
    dimensions?: number;
    upstream: EmbedUpstream;
    model: string;
    lock?: EmbedLock | null;
  },
): Promise<{ embeddings: number[][]; indices: number[] }> {
  const dimensions = options.dimensions;
  const indexed = inputs.map((text, i) => ({ text, i }));
  const nonEmpty = indexed.filter((x) => x.text.trim().length > 0);
  const batches = chunkArray(nonEmpty, options.upstream.maxBatch);
  const vectors = new Map<number, number[]>();

  for (const batch of batches) {
    const texts = batch.map((b) => b.text);
    const got = await options.upstream.embed(texts, options.model, dimensions);
    for (let j = 0; j < batch.length; j++) {
      let vec = got[j] ?? [];
      if (dimensions && vec.length > dimensions) vec = mrlSlice(vec, dimensions);
      else if (dimensions && vec.length === dimensions) vec = l2Normalize(vec);
      if (dimensions) assertDimensionFingerprint(options.lock ?? null, vec.length);
      vectors.set(batch[j].i, vec);
    }
  }

  const dim = dimensions ?? (vectors.values().next().value?.length ?? 0);
  const embeddings: number[][] = [];
  const indices: number[] = [];
  for (let i = 0; i < inputs.length; i++) {
    indices.push(i);
    embeddings.push(vectors.get(i) ?? new Array(dim).fill(0));
  }
  return { embeddings, indices };
}

/** Configuration and data shape for `EmbedServerOptions` (embed server options). */
export type EmbedServerOptions = {
  port: number;
  repoRoot: string;
  upstream: EmbedUpstream;
  defaultModel: string;
};

/** Executes `createEmbedRequestHandler` to create embed request handler in `dbwatch`. */
export function createEmbedRequestHandler(opts: EmbedServerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/embeddings")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readBody(req);
    let parsed: {
      input?: string | string[];
      model?: string;
      dimensions?: number;
      encoding_format?: string;
    };
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("Invalid JSON");
      return;
    }
    const input = Array.isArray(parsed.input)
      ? parsed.input
      : parsed.input
        ? [parsed.input]
        : [];
    const lock = readEmbedLock(opts.repoRoot);
    try {
      const { embeddings } = await normalizeEmbedBatch(input, {
        dimensions: parsed.dimensions,
        upstream: opts.upstream,
        model: parsed.model ?? opts.defaultModel,
        lock,
      });
      if (parsed.dimensions && !lock) {
        writeEmbedLock(opts.repoRoot, {
          provider: opts.upstream.name,
          model: parsed.model ?? opts.defaultModel,
          dimension: parsed.dimensions,
        });
      }
      const data = embeddings.map((embedding, index) => {
        if (parsed.encoding_format === "base64") {
          return { object: "embedding", index, embedding: floatArrayToBase64(embedding) };
        }
        return { object: "embedding", index, embedding };
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data, model: parsed.model, usage: {} }));
    } catch (e) {
      res.writeHead(400);
      res.end(String(e));
    }
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Executes `startEmbedServer` to start embed server in `dbwatch`. */
export function startEmbedServer(opts: EmbedServerOptions): ReturnType<typeof createServer> {
  const server = createServer(createEmbedRequestHandler(opts));
  server.listen(opts.port, "127.0.0.1");
  return server;
}

/** Executes `createDashScopeUpstream` to create dash scope upstream in `dbwatch`. */
export function createDashScopeUpstream(
  fetchImpl: typeof fetch = fetch,
  opts?: { apiKey?: string },
): EmbedUpstream {
  return {
    name: "dashscope",
    maxBatch: 10,
    embed: async (input, model, dimensions) => {
      const key = opts?.apiKey ?? process.env.DASHSCOPE_API_KEY;
      if (!key) {
        throw new Error("DASHSCOPE_API_KEY is required for DashScope embed upstream");
      }
      const res = await fetchImpl("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input, dimensions }),
      });
      const j = (await res.json()) as { data?: Array<{ embedding: number[] }> };
      return (j.data ?? []).map((d) => d.embedding);
    },
  };
}

/** Constant `DEFAULT_N_CTX` defining default n ctx. */
export const DEFAULT_N_CTX = 4096;
/** Constant `TRUNCATION_MARKER` defining truncation marker. */
export const TRUNCATION_MARKER = "[...TRUNCATED BY DBWATCH CONTEXT GUARD...]";

/** Executes `probeNCtx` to probe nctx in `dbwatch`. */
export async function probeNCtx(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ nCtx: number; source: string }> {
  const base = baseUrl.replace(/\/$/, "");
  try {
    const props = await fetchImpl(`${base}/props`);
    if (props.ok) {
      const j = (await props.json()) as { n_ctx?: number };
      if (typeof j.n_ctx === "number" && j.n_ctx > 0) return { nCtx: j.n_ctx, source: "llama.cpp" };
    }
  } catch {
    /* continue */
  }
  try {
    const models = await fetchImpl(`${base}/v1/models`);
    if (models.ok) {
      const j = (await models.json()) as { data?: Array<{ max_model_len?: number }> };
      const n = j.data?.[0]?.max_model_len;
      if (n && n > 0) return { nCtx: n, source: "vllm" };
    }
  } catch {
    /* continue */
  }
  return { nCtx: DEFAULT_N_CTX, source: "fallback" };
}

/** Executes `headTailTruncate` to head tail truncate in `dbwatch`. */
export function headTailTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headLen = Math.floor(maxChars * 0.6);
  const tailLen = Math.floor(maxChars * 0.4) - TRUNCATION_MARKER.length;
  if (tailLen < 0) return text.slice(0, maxChars);
  return text.slice(0, headLen) + TRUNCATION_MARKER + text.slice(-tailLen);
}

/** Executes `truncateToolOutput` to truncate tool output in `dbwatch`. */
export function truncateToolOutput(text: string, nCtx: number): string {
  const budget = Math.floor(nCtx * 4 * 0.3);
  return headTailTruncate(text, budget);
}

/** Executes `buildRecencyAnchor` to build recency anchor in `dbwatch`. */
export function buildRecencyAnchor(sigs: Array<{ name: string; summary: string }>): string {
  const lines = sigs.map((s) => `- ${s.name}: ${s.summary}`);
  return [
    "[AVAILABLE TOOLS � ANCHORED FOR RECENCY]",
    ...lines,
    'To call a tool, output ONLY: <tool_call>{"name": "TOOL_NAME", "arguments": {...}}</tool_call>',
  ].join("\n");
}

/** Executes `anchorPromptTail` to anchor prompt tail in `dbwatch`. */
export function anchorPromptTail(prompt: string, anchor: string): string {
  const marker = "\nASSISTANT:";
  const idx = prompt.lastIndexOf(marker);
  if (idx === -1) return `${prompt}\n\n${anchor}\n${marker}`;
  return `${prompt.slice(0, idx)}\n\n${anchor}\n${prompt.slice(idx)}`;
}

/** Stateful helper class `StreamToolJsonAbort` (stream tool json abort). */
export class StreamToolJsonAbort {
  private depth = 0;
  private started = false;
  private acc = "";

  /** Member `feed` (feed). */
  feed(chunk: string): boolean {
    this.acc += chunk;
    if (!this.started) {
      if (
        /<tool_call>/i.test(this.acc) ||
        /\u273FFUNCTION\u273F/i.test(this.acc) ||
        /tool_call_argument_begin/i.test(this.acc) ||
        /"name"\s*:\s*"/.test(this.acc)
      ) {
        this.started = true;
      }
    }
    this.depth = countBraceFrom(this.acc);
    return this.started && this.depth === 0 && /\{[\s\S]*\}/.test(this.acc);
  }
}

function countBraceFrom(text: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

/** Executes `stripRedactedThinking` to strip redacted thinking in `dbwatch`. */
export function stripRedactedThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(?:<\/redacted_thinking>|$)/gi, "");
}

function repairJson(raw: string): string {
  let s = raw.trim();
  if (!s) return "{}";
  s = s.replace(/,\s*([}\]])/g, "$1");
  s = s.replace(/'/g, '"');
  s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');
  const open = (s.match(/\{/g) ?? []).length;
  const close = (s.match(/\}/g) ?? []).length;
  if (open > close) s += "}".repeat(open - close);
  return s;
}

function tryParseObject(raw: string): Record<string, unknown> | null {
  for (const a of [raw, repairJson(raw)]) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Executes `parseDirtyToolCall` to parse dirty tool call in `dbwatch`. */
export function parseDirtyToolCall(content: string): { name: string; arguments: Record<string, unknown> } | null {
  const text = stripRedactedThinking(content);
  const hermes = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i);
  if (hermes) {
    const obj = tryParseObject(hermes[1]);
    if (obj?.name && typeof obj.name === "string") {
      return {
        name: obj.name,
        arguments: (obj.arguments as Record<string, unknown>) ?? {},
      };
    }
  }
  const kimi = text.match(
    /functions\.([^:<|]+):\d+<\|(?:redacted_)?tool_call_argument_begin\|>([\s\S]*?)<\|(?:redacted_)?tool_call_end[^|]*\|>/i,
  );
  if (kimi) {
    const obj = tryParseObject(kimi[2]);
    return { name: kimi[1].trim(), arguments: obj ?? {} };
  }
  const glm = text.match(
    /<\|(?:redacted_)?tool_call_begin[^|]*\|>([^<|]+)<\|tool_call_sep\|>([\s\S]*?)<\|(?:redacted_)?tool_call_end[^|]*\|>/i,
  );
  if (glm) {
    const obj = tryParseObject(glm[2]);
    return { name: glm[1].trim(), arguments: obj ?? {} };
  }
  const qwenFn = text.match(
    /\u273FFUNCTION\u273F:\s*([^\n]+)\s*\u273FARGS\u273F:\s*([\s\S]*?)(?:\u273FRESULT\u273F|$)/i,
  );
  if (qwenFn) {
    const obj = tryParseObject(qwenFn[2]);
    return { name: qwenFn[1].trim(), arguments: obj ?? {} };
  }
  const iq = text.match(/\{\s*['"]?cmd['"]?\s*:\s*['"]([^'"]+)['"]/);
  if (iq) return { name: "run_shell", arguments: { cmd: iq[1] } };
  const broken = tryParseObject(text);
  if (broken?.cmd) return { name: "run_shell", arguments: broken };
  return null;
}

/** Configuration and data shape for `ChatMessage` (chat message). */
export type ChatMessage = {
  role: string;
  content?: string | null;
  tool_calls?: unknown[];
  reasoning_content?: string;
};

/** Configuration and data shape for `ProviderId` (provider id). */
export type ProviderId =
  | "deepseek"
  | "dashscope"
  | "moonshot"
  | "zhipu"
  | "minimax"
  | "siliconflow"
  | "doubao"
  | "generic"
  | "ollama"
  | "openai";

/** Executes `detectProvider` to detect provider in `dbwatch`. */
export function detectProvider(baseUrl: string, model?: string): ProviderId {
  const u = baseUrl.toLowerCase();
  if (u.includes("deepseek")) return "deepseek";
  if (u.includes("dashscope")) return "dashscope";
  if (u.includes("moonshot")) return "moonshot";
  if (u.includes("bigmodel") || u.includes("zhipu")) return "zhipu";
  if (u.includes("minimax")) return "minimax";
  if (u.includes("siliconflow")) return "siliconflow";
  if (u.includes("volces")) return "doubao";
  if (u.includes("11434") || u.includes("ollama")) return "ollama";
  if (u.includes("openai")) return "openai";
  return "generic";
}

/** Executes `sanitizeRequestBody` to sanitize request body in `dbwatch`. */
export function sanitizeRequestBody(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const out = { ...body };
  if (/reasoner|qwq|glm-z1|thinking/i.test(model)) {
    for (const key of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) {
      delete out[key];
    }
  }
  return out;
}

/** Executes `normalizeToolChoice` to normalize tool choice in `dbwatch`. */
export function normalizeToolChoice(toolChoice: unknown, provider: ProviderId): unknown {
  if (toolChoice === "required" || toolChoice === "any") {
    switch (provider) {
      case "dashscope":
      case "moonshot":
      case "zhipu":
      case "minimax":
      case "siliconflow":
      case "doubao":
        return "auto";
      default:
        return toolChoice;
    }
  }
  return toolChoice;
}

/** Configuration and data shape for `ReasoningState` (reasoning state). */
export type ReasoningState = { inToolLoop: boolean; lastUserTurnIndex: number };

/** Executes `createReasoningState` to create reasoning state in `dbwatch`. */
export function createReasoningState(): ReasoningState {
  return { inToolLoop: false, lastUserTurnIndex: -1 };
}

/** Executes `applyReasoningContentPolicy` to apply reasoning content policy in `dbwatch`. */
export function applyReasoningContentPolicy(
  messages: ChatMessage[],
  state: ReasoningState,
): { messages: ChatMessage[]; state: ReasoningState } {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") lastUser = i;
  }
  const newUserTurn = lastUser > state.lastUserTurnIndex;
  if (newUserTurn) {
    state = { ...state, lastUserTurnIndex: lastUser, inToolLoop: false };
  }
  const hasPendingTools = messages.some(
    (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
  );
  if (hasPendingTools) state = { ...state, inToolLoop: true };
  const cleaned = messages.map((m, idx) => {
    const copy = { ...m };
    if (copy.content && typeof copy.content === "string") {
      copy.content = stripRedactedThinking(copy.content);
    }
    if (newUserTurn && copy.role === "assistant" && idx < lastUser) {
      delete copy.reasoning_content;
    }
    if (!state.inToolLoop && copy.role === "assistant") {
      delete copy.reasoning_content;
    }
    return copy;
  });
  return { messages: cleaned, state };
}

/** Executes `redactSecrets` to redact secrets in `dbwatch`. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(api[_-]?key|token|password|secret)\s*[=:]\s*[^\s]+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED]");
}

/** Executes `finalizeMcpToolText` to finalize mcp tool text in `dbwatch`. */
export function finalizeMcpToolText(
  text: string,
  opts?: { nCtx?: number; toWsl?: boolean },
): string {
  const nCtx = opts?.nCtx ?? DEFAULT_N_CTX;
  const toWsl = opts?.toWsl ?? false;
  return normalizePathsDeep(
    redactSecrets(truncateToolOutput(String(text), nCtx)),
    !toWsl,
  );
}
