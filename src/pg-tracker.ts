export function isPostgresDsn(dsn: string): boolean {
  return dsn.startsWith("postgres://") || dsn.startsWith("postgresql://");
}

export function parsePostgresDsn(dsn: string): { host: string; database: string } {
  try {
    const u = new URL(dsn);
    return { host: u.hostname, database: u.pathname.replace(/^\//, "") || "postgres" };
  } catch {
    return { host: "localhost", database: "postgres" };
  }
}

/** Postgres live diff is planned; SQLite/D1 local file paths are supported today. */
export function assertPostgresSupported(dsn: string): void {
  if (isPostgresDsn(dsn)) {
    throw new Error(
      "Postgres live diff is not enabled in this build. Use sqlite: or d1: for local tests.",
    );
  }
}
