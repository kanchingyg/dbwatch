import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  type DbSnapshot,
  type RowChange,
  diffSnapshots,
  formatDiffLine,
  inverseSql,
  rowKey,
} from "./differ.js";
const WIN_DRIVE_RE = /^([A-Za-z]):\\(.*)$/;
const WSL_RE = /^\/mnt\/([a-z])\/(.*)$/i;

function windowsToWsl(p: string): string {
  const m = p.match(WIN_DRIVE_RE);
  if (!m) return p;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

function wslToWindows(p: string): string {
  const m = p.match(WSL_RE);
  if (!m) return p;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}

export type DiffRecord = {
  id: string;
  dsn: string;
  changes: RowChange[];
  pkCols: Record<string, string>;
  lines: string[];
  inverse: string[];
};

const diffStore = new Map<string, DiffRecord>();

function diffStoreDirForDsn(dsn: string, cwd = process.cwd()): string {
  const dbPath = resolveSqlitePath(dsn, cwd);
  const base = dbPath === ":memory:" || dbPath === "" ? cwd : dirname(dbPath);
  return join(base, ".dbwatch", "diffs");
}

function diffFilePath(id: string, dsn: string): string {
  return join(diffStoreDirForDsn(dsn), `${id}.json`);
}

function collectDiffDirs(): string[] {
  const dirs = new Set<string>();
  dirs.add(join(process.cwd(), ".dbwatch", "diffs"));
  for (const rec of diffStore.values()) {
    dirs.add(diffStoreDirForDsn(rec.dsn));
  }
  return [...dirs];
}

function persistDiffRecord(rec: DiffRecord): void {
  const dir = diffStoreDirForDsn(rec.dsn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${rec.id}.json`), JSON.stringify(rec), "utf8");
}

function loadDiffRecord(id: string, dsnHint?: string): DiffRecord | undefined {
  if (dsnHint) {
    const hinted = join(diffStoreDirForDsn(dsnHint), `${id}.json`);
    if (existsSync(hinted)) {
      return JSON.parse(readFileSync(hinted, "utf8")) as DiffRecord;
    }
  }
  for (const dir of collectDiffDirs()) {
    const path = join(dir, `${id}.json`);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as DiffRecord;
    }
  }
  return undefined;
}

function removeDiffRecord(id: string, dsn: string): void {
  const path = diffFilePath(id, dsn);
  if (existsSync(path)) unlinkSync(path);
}

export function clearDiffStore(): void {
  diffStore.clear();
}

export function getDiffRecord(id: string, dsnHint?: string): DiffRecord | undefined {
  const cached = diffStore.get(id);
  if (cached) return cached;
  const loaded = loadDiffRecord(id, dsnHint);
  if (loaded) diffStore.set(id, loaded);
  return loaded;
}

export function listDiffIds(): string[] {
  const ids = new Set(diffStore.keys());
  for (const dir of collectDiffDirs()) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".json")) ids.add(name.slice(0, -".json".length));
    }
  }
  return [...ids].sort();
}

export function assertPathContainedUnderCwd(path: string, cwd = process.cwd()): string {
  if (path === ":memory:" || path === "") return path;
  const resolved = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Database path must stay under cwd (${cwd}): ${path}`);
  }
  return resolved;
}

export function resolveSqlitePath(dsn: string, cwd = process.cwd()): string {
  let p = dsn;
  if (p.startsWith("sqlite:")) p = p.slice("sqlite:".length);
  if (p.startsWith("file:")) p = p.slice("file:".length);
  if (p.startsWith("d1:")) p = p.slice("d1:".length);
  if (p.startsWith("/mnt/")) p = wslToWindows(p);
  return assertPathContainedUnderCwd(p, cwd);
}

export function openSqlite(dsn: string, cwd = process.cwd()): DatabaseSync {
  const path = resolveSqlitePath(dsn, cwd);
  if (path === ":memory:" || path === "") {
    return new DatabaseSync(":memory:");
  }
  return new DatabaseSync(path);
}

export function detectPkCol(db: DatabaseSync, table: string): string {
  const info = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  const pk = info.find((c) => c.pk > 0);
  if (pk) return pk.name;
  return "rowid";
}

function quote(table: string): string {
  return `"${table.replace(/"/g, '""')}"`;
}

export function listUserTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function captureSnapshot(db: DatabaseSync): { snap: DbSnapshot; pkCols: Record<string, string> } {
  const snap: DbSnapshot = {};
  const pkCols: Record<string, string> = {};
  for (const table of listUserTables(db)) {
    const pkCol = detectPkCol(db, table);
    pkCols[table] = pkCol;
    const rows = db.prepare(`SELECT * FROM ${quote(table)}`).all() as Record<string, unknown>[];
    const indexed: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      const key = rowKey(table, pkCol, row);
      indexed[key] = row;
    }
    snap[table] = indexed;
  }
  return { snap, pkCols };
}

export function applyInverseSql(db: DatabaseSync, sql: string[]): void {
  for (const stmt of sql) {
    db.exec(stmt);
  }
}

export type RunResult = {
  exitCode: number;
  diffId: string;
  changes: RowChange[];
  lines: string[];
};

export function runWithSqliteDiff(
  dsn: string,
  cmd: string[],
  opts: { env?: Record<string, string> } = {},
): RunResult {
  const db = openSqlite(dsn);
  const before = captureSnapshot(db);
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
    ),
    ...opts.env,
    DBWATCH_DSN: resolveSqlitePath(dsn),
  };
  const normalizedDsn = windowsToWsl(resolveSqlitePath(dsn));
  if (normalizedDsn !== resolveSqlitePath(dsn)) {
    env.DBWATCH_DSN_WSL = normalizedDsn;
  }

  const child = spawnSync(cmd[0], cmd.slice(1), {
    env,
    stdio: "inherit",
    shell: false,
  });
  const exitCode = child.status ?? 1;

  const after = captureSnapshot(db);
  const changes = diffSnapshots(before.snap, after.snap, before.pkCols);
  const lines = changes.map(formatDiffLine);
  const inverse = changes.map((c) => inverseSql(c, before.pkCols[c.table] ?? "rowid"));
  const id = `diff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record: DiffRecord = {
    id,
    dsn,
    changes,
    pkCols: before.pkCols,
    lines,
    inverse,
  };
  diffStore.set(id, record);
  persistDiffRecord(record);
  db.close();
  return { exitCode, diffId: id, changes, lines };
}

export function revertDiff(diffId: string, dryRun: boolean): { sql: string[]; applied: boolean } {
  const rec = getDiffRecord(diffId);
  if (!rec) throw new Error(`Unknown diffId: ${diffId}`);
  if (dryRun) return { sql: rec.inverse, applied: false };
  const db = openSqlite(rec.dsn);
  applyInverseSql(db, rec.inverse);
  db.close();
  diffStore.delete(diffId);
  removeDiffRecord(diffId, rec.dsn);
  return { sql: rec.inverse, applied: true };
}

export function runScriptOnDb(db: DatabaseSync, sql: string): void {
  db.exec(sql);
}

export function runWithSqliteMutation(
  dsn: string,
  mutate: (db: DatabaseSync) => void,
): RunResult {
  const db = openSqlite(dsn);
  const before = captureSnapshot(db);
  mutate(db);
  const after = captureSnapshot(db);
  const changes = diffSnapshots(before.snap, after.snap, before.pkCols);
  const lines = changes.map(formatDiffLine);
  const inverse = changes.map((c) => inverseSql(c, before.pkCols[c.table] ?? "rowid"));
  const id = `diff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const record: DiffRecord = {
    id,
    dsn,
    changes,
    pkCols: before.pkCols,
    lines,
    inverse,
  };
  diffStore.set(id, record);
  persistDiffRecord(record);
  db.close();
  return { exitCode: 0, diffId: id, changes, lines };
}
