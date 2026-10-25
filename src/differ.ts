export type RowOp = "insert" | "update" | "delete";

export type RowChange = {
  table: string;
  op: RowOp;
  pk: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

export type TableSnapshot = Record<string, Record<string, unknown>>;

export type DbSnapshot = Record<string, TableSnapshot>;

export function rowKey(table: string, pkCol: string, row: Record<string, unknown>): string {
  const pk = row[pkCol];
  return `${table}:${String(pk)}`;
}

export function diffSnapshots(
  before: DbSnapshot,
  after: DbSnapshot,
  pkCols: Record<string, string>,
): RowChange[] {
  const changes: RowChange[] = [];
  const tables = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const table of tables) {
    const pkCol = pkCols[table] ?? "rowid";
    const b = before[table] ?? {};
    const a = after[table] ?? {};
    const keys = new Set([...Object.keys(b), ...Object.keys(a)]);

    for (const k of keys) {
      const br = b[k];
      const ar = a[k];
      if (br && ar) {
        if (JSON.stringify(br) !== JSON.stringify(ar)) {
          changes.push({ table, op: "update", pk: k, before: br, after: ar });
        }
      } else if (ar) {
        changes.push({ table, op: "insert", pk: k, after: ar });
      } else if (br) {
        changes.push({ table, op: "delete", pk: k, before: br });
      }
    }
  }
  return changes;
}

export function formatDiffLine(c: RowChange): string {
  const id = c.pk.split(":").slice(1).join(":");
  switch (c.op) {
    case "insert":
      return `+ INSERT ${c.table} (${id}) ${JSON.stringify(c.after)}`;
    case "delete":
      return `- DELETE ${c.table} (${id}) ${JSON.stringify(c.before)}`;
    case "update":
      return `~ UPDATE ${c.table} (${id}) ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`;
    default: {
      const _never: never = c.op;
      return String(_never);
    }
  }
}

export function inverseSql(c: RowChange, pkCol: string): string {
  switch (c.op) {
    case "insert": {
      const cols = Object.keys(c.after ?? {});
      const vals = cols.map((col) => sqlLiteral(c.after![col]));
      return `DELETE FROM ${quoteIdent(c.table)} WHERE ${quoteIdent(pkCol)} = ${sqlLiteral(c.after![pkCol])};`;
    }
    case "delete": {
      const row = c.before ?? {};
      const cols = Object.keys(row);
      return `INSERT INTO ${quoteIdent(c.table)} (${cols.map(quoteIdent).join(", ")}) VALUES (${cols.map((col) => sqlLiteral(row[col])).join(", ")});`;
    }
    case "update": {
      const row = c.before ?? {};
      const sets = Object.keys(row)
        .filter((col) => col !== pkCol)
        .map((col) => `${quoteIdent(col)} = ${sqlLiteral(row[col])}`)
        .join(", ");
      return `UPDATE ${quoteIdent(c.table)} SET ${sets} WHERE ${quoteIdent(pkCol)} = ${sqlLiteral(row[pkCol])};`;
    }
    default: {
      const _never: never = c.op;
      return String(_never);
    }
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}
