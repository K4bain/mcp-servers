import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";

type DbType = "sqlite" | "postgres" | "mysql";

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

function dbType(): DbType {
  const t = (process.env.DB_TYPE ?? "").toLowerCase();
  if (t === "postgres" || t === "postgresql") return "postgres";
  if (t === "mysql" || t === "mariadb") return "mysql";
  return "sqlite";
}

const writesAllowed = /^(1|true|yes)$/i.test(process.env.ALLOW_WRITES ?? "");

function assertReadOnly(sql: string): void {
  if (writesAllowed) return;
  const q = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim().toLowerCase();
  if (!q) throw new Error("Empty query.");
  if (!/^(select|with|show|explain|table|pragma\s+table_info)\b/.test(q)) {
    throw new Error("Read-only mode: only SELECT/WITH/SHOW/EXPLAIN queries allowed. Set ALLOW_WRITES=true to enable writes.");
  }
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/.test(q)) {
    throw new Error("Read-only mode: write keywords are not allowed. Set ALLOW_WRITES=true to enable writes.");
  }
}

function assertSafeIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier "${name}".`);
  }
  return name;
}

let sqlite: DatabaseSync | null = null;

function getSqlite(): DatabaseSync {
  if (!sqlite) {
    sqlite = new DatabaseSync(process.env.SQLITE_PATH ?? ":memory:");
  }
  return sqlite;
}

let pgClient: any = null;

async function getPg(): Promise<any> {
  if (!pgClient) {
    const { Client } = await import("pg");
    pgClient = new Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();
  }
  return pgClient;
}

type MysqlPool = {
  query: (sql: string, params?: unknown[]) => Promise<[Record<string, unknown>[], unknown]>;
};

let mysqlPool: MysqlPool | null = null;

async function getMysql(): Promise<MysqlPool> {
  if (!mysqlPool) {
    const mysql = await import("mysql2/promise");
    mysqlPool = mysql.createPool(process.env.DATABASE_URL!) as unknown as MysqlPool;
  }
  return mysqlPool;
}

export async function runQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
  assertReadOnly(sql);
  const type = dbType();
  if (type === "sqlite") {
    const stmt = getSqlite().prepare(sql);
    const rawRows = (params.length > 0 ? stmt.all(...(params as any[])) : stmt.all()) as Record<string, unknown>[];
    const rows = rawRows;
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { columns, rows, rowCount: rows.length };
  }
  if (type === "postgres") {
    const client = await getPg();
    const r = await client.query(sql, params);
    return {
      columns: r.fields?.map((f: any) => f.name) ?? [],
      rows: r.rows ?? [],
      rowCount: r.rowCount ?? r.rows?.length ?? 0,
    };
  }
  const pool = await getMysql();
  const [rows] = await pool.query(sql, params);
  const arr = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [{ result: rows }];
  return { columns: arr.length > 0 ? Object.keys(arr[0]) : [], rows: arr, rowCount: arr.length };
}

async function listTablesDb(): Promise<string[]> {
  const type = dbType();
  if (type === "sqlite") {
    const r = await runQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    return r.rows.map((row) => String(row.name));
  }
  if (type === "postgres") {
    const r = await runQuery("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
    return r.rows.map((row) => String(row.table_name));
  }
  const r = await runQuery(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type='BASE TABLE' ORDER BY table_name`);
  return r.rows.map((row) => String(row.t));
}

async function describeTableDb(table: string): Promise<{ column: string; dataType: string; nullable: boolean }[]> {
  assertSafeIdentifier(table);
  const type = dbType();
  if (type === "sqlite") {
    const r = await runQuery(`PRAGMA table_info(${table})`);
    return r.rows.map((row: any) => ({
      column: row.name,
      dataType: row.type || "BLOB",
      nullable: row.notnull === 0,
    }));
  }
  if (type === "postgres") {
    const r = await runQuery(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table]
    );
    return r.rows.map((row: any) => ({ column: row.column_name, dataType: row.data_type, nullable: row.is_nullable === "YES" }));
  }
  const r = await runQuery(
    `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map((row: any) => ({ column: row.column_name, dataType: row.data_type, nullable: row.is_nullable === "YES" }));
}

async function insertRowDb(table: string, data: Record<string, unknown>): Promise<number> {
  if (!writesAllowed) throw new Error("Writes disabled. Set ALLOW_WRITES=true.");
  assertSafeIdentifier(table);
  const cols = Object.keys(data);
  if (cols.length === 0) throw new Error("No values provided.");
  cols.forEach(assertSafeIdentifier);
  const type = dbType();
  let sql: string;
  let params: unknown[];
  if (type === "postgres") {
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
    params = Object.values(data);
  } else {
    const placeholders = cols.map(() => "?").join(", ");
    sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;
    params = Object.values(data);
  }
  const r = await runQueryWithWrite(sql, params);
  return r.rowCount;
}

async function runQueryWithWrite(sql: string, params: unknown[]): Promise<QueryResult> {
  const type = dbType();
  if (type === "sqlite") {
    const info = getSqlite().prepare(sql).run(...(params as any[]));
    return { columns: [], rows: [], rowCount: Number(info.changes) };
  }
  if (type === "postgres") {
    const client = await getPg();
    const r = await client.query(sql, params);
    return { columns: [], rows: r.rows ?? [], rowCount: r.rowCount };
  }
  const pool = await getMysql();
  const [result]: any = await pool.query(sql, params);
  return { columns: [], rows: [], rowCount: result.affectedRows ?? 0 };
}

const server = new McpServer({
  name: "database-query-mcp",
  version: "1.0.0",
});

server.registerTool(
  "list_tables",
  {
    title: "List Tables",
    description: "List all tables in the connected database.",
    inputSchema: {},
  },
  async () => {
    try {
      const tables = await listTablesDb();
      if (tables.length === 0) return text("No tables found.");
      return text(`${tables.length} table(s):\n${tables.map((t) => `- ${t}`).join("\n")}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "describe_table",
  {
    title: "Describe Table",
    description: "Show column names, data types and nullability for a table.",
    inputSchema: { table_name: z.string() },
  },
  async ({ table_name }) => {
    try {
      const cols = await describeTableDb(table_name);
      if (cols.length === 0) return text(`Table "${table_name}" not found or has no columns.`);
      return text(cols.map((c) => `${c.column} — ${c.dataType}${c.nullable ? "" : " NOT NULL"}`).join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "execute_query",
  {
    title: "Execute SQL",
    description:
      "Run a SQL query. Read-only by default (SELECT/WITH/SHOW/EXPLAIN); set ALLOW_WRITES=true to permit writes. Use parameterized queries where supported.",
    inputSchema: {
      sql: z.string().min(1),
      params: z.array(z.any()).optional().describe("Optional bind parameters ($1.. for Postgres, ? for MySQL/SQLite)"),
    },
  },
  async ({ sql, params }) => {
    try {
      const r = await runQuery(sql, params ?? []);
      if (r.rows.length === 0) {
        return text(writesAllowed && r.rowCount > 0 ? `OK, ${r.rowCount} row(s) affected.` : "Query returned 0 rows.");
      }
      const maxRows = Math.min(r.rows.length, 200);
      const lines = [r.columns.join(" | ")];
      for (const row of r.rows.slice(0, maxRows)) {
        lines.push(r.columns.map((c) => formatCell(row[c])).join(" | "));
      }
      if (r.rows.length > maxRows) lines.push(`… (${r.rows.length - maxRows} more rows)`);
      return text(`${r.rowCount} row(s):\n${lines.join("\n")}`);
    } catch (e) {
      return errText(e);
    }
  }
);

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

server.registerTool(
  "insert_row",
  {
    title: "Insert Row",
    description:
      "Safely insert one record into a table using parameterized statements. Requires ALLOW_WRITES=true.",
    inputSchema: {
      table_name: z.string(),
      data: z.record(z.any()).describe('Column → value map, e.g. {"name": "Ali", "city": "Lahore"}'),
    },
  },
  async ({ table_name, data }) => {
    try {
      const n = await insertRowDb(table_name, data);
      return text(`Inserted 1 row into ${table_name} (${n} change(s) reported).`);
    } catch (e) {
      return errText(e);
    }
  }
);

await server.connect(new StdioServerTransport());
console.error(`[database-query-mcp] connected over stdio (db=${dbType()}, writes=${writesAllowed ? "ON" : "OFF"})`);
