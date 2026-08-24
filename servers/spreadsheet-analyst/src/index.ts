import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const s = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function sanitizeIdent(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^(\d)/, "t$1").toLowerCase();
  return clean || "table";
}

function isNumeric(v: string): boolean {
  if (v.trim() === "") return true;
  return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.trim());
}

function inferColumnTypes(rows: string[][], colCount: number): string[] {
  return Array.from({ length: colCount }, (_, colIdx) => {
    const values = rows.map((r) => r[colIdx] ?? "").filter((v) => v.trim() !== "");
    if (values.length === 0) return "TEXT";
    if (values.every((v) => /^-?\d+$/.test(v.trim()))) return "INTEGER";
    if (values.every(isNumeric)) return "REAL";
    return "TEXT";
  });
}

interface TableInfo {
  name: string;
  sourceFile: string;
  rowCount: number;
  columns: string[];
}

export async function loadCsvIntoDb(filePath: string, tableName?: string): Promise<TableInfo> {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const content = (await readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
  const delimiter = filePath.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  let grid: string[][];
  if (delimiter === "\t") {
    grid = content
      .split("\n")
      .map((line) => line.replace(/\r$/, "").split("\t"))
      .filter((r) => !(r.length === 1 && r[0].trim() === ""));
  } else {
    grid = parseCsv(content);
  }
  if (grid.length < 2) throw new Error("CSV must have a header row plus at least one data row.");
  const headers = grid[0].map((h, idx) => sanitizeIdent(h || `col_${idx + 1}`));
  const seen = new Set<string>();
  const uniqueHeaders = headers.map((h) => {
    let name = h;
    let n = 2;
    while (seen.has(name)) name = `${h}_${n++}`;
    seen.add(name);
    return name;
  });
  const dataRows = grid.slice(1).map((r) => {
    while (r.length < uniqueHeaders.length) r.push("");
    return r.slice(0, uniqueHeaders.length);
  });
  const types = inferColumnTypes(dataRows, uniqueHeaders.length);
  const tName = sanitizeIdent(tableName ?? path.basename(filePath, path.extname(filePath)));
  db.exec(`DROP TABLE IF EXISTS "${tName}"`);
  db.exec(`CREATE TABLE "${tName}" (${uniqueHeaders.map((h, i) => `"${h}" ${types[i]}`).join(", ")})`);
  const stmt = db.prepare(`INSERT INTO "${tName}" VALUES (${uniqueHeaders.map(() => "?").join(", ")})`);
  for (const row of dataRows) {
    stmt.run(
      ...row.map((v, i) => {
        const tv = v.trim();
        if (tv === "") return null;
        if (types[i] === "INTEGER") return parseInt(tv, 10);
        if (types[i] === "REAL") return parseFloat(tv);
        return v;
      })
    );
  }
  return { name: tName, sourceFile: filePath, rowCount: dataRows.length, columns: uniqueHeaders };
}

function assertReadOnly(query: string): void {
  const q = query
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim()
    .toLowerCase();
  if (!q) throw new Error("Empty query.");
  if (!/^(select|with)\b/.test(q)) {
    throw new Error("Only read-only SELECT/WITH queries are allowed here. Loaded tables live only in memory.");
  }
  if (/\b(insert|update|delete|drop|alter|create|attach|detach|pragma)\b/.test(q)) {
    throw new Error("Write/schema keywords are not allowed in queries.");
  }
}

function assertSafeIdentifier(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Invalid identifier "${name}". Use only letters, digits and underscores.`);
  }
  return name;
}

const server = new McpServer({ name: "spreadsheet-analyst-mcp", version: "1.0.0" });

server.registerTool(
  "load_csv",
  {
    title: "Load CSV File",
    description:
      "Load a local CSV/TSV file into an in-memory SQL database so it can be queried with query_sql. First row is the header.",
    inputSchema: {
      file_path: z.string().describe("Path to the .csv or .tsv file"),
      table_name: z.string().optional().describe("Custom table name (defaults to the filename)"),
    },
  },
  async ({ file_path, table_name }) => {
    try {
      const info = await loadCsvIntoDb(file_path, table_name);
      const cols = db.prepare(`PRAGMA table_info("${info.name}")`).all() as any[];
      return text(
        `Loaded ${info.rowCount} rows into table "${info.name}".\nColumns: ${cols.map((c) => `${c.name} (${c.type})`).join(", ")}`
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "list_tables",
  {
    title: "List Loaded Tables",
    description: "List all tables loaded in this session.",
    inputSchema: {},
  },
  async () => {
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as any[];
      if (tables.length === 0) return text("No tables loaded yet. Use load_csv first.");
      const lines = tables.map((t) => {
        const count = (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).all() as any[])[0].n;
        const cols = (db.prepare(`PRAGMA table_info("${t.name}")`).all() as any[]).map((c) => c.name);
        return `"${t.name}" — ${count} rows — columns: ${cols.join(", ")}`;
      });
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "describe_table",
  {
    title: "Describe Table",
    description: "Schema plus per-column stats (distinct count, min/max/avg for numerics, most common values).",
    inputSchema: { table_name: z.string() },
  },
  async ({ table_name }) => {
    try {
      assertSafeIdentifier(table_name);
      const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).all(table_name);
      if (exists.length === 0) throw new Error(`Table "${table_name}" not found. Use list_tables.`);
      const cols = db.prepare(`PRAGMA table_info("${table_name}")`).all() as any[];
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM "${table_name}"`).all() as any[])[0].n as number;
      const parts: string[] = [`Table "${table_name}" — ${total} rows`];
      for (const c of cols) {
        const stats = (
          db
            .prepare(
              `SELECT COUNT(DISTINCT "${c.name}") AS distinct_n,
                      MIN(CAST("${c.name}" AS REAL)) AS min_v,
                      MAX(CAST("${c.name}" AS REAL)) AS max_v,
                      AVG(CASE WHEN typeof("${c.name}") IN ('integer','real') THEN CAST("${c.name}" AS REAL) END) AS avg_v
               FROM "${table_name}"`
            )
            .all() as any[]
        )[0];
        const top = db
          .prepare(`SELECT "${c.name}" AS val, COUNT(*) AS n FROM "${table_name}" GROUP BY 1 ORDER BY n DESC LIMIT 3`)
          .all() as any[];
        const topStr = top.map((t) => `${String(t.val)}×${t.n}`).join(", ");
        parts.push(
          `- ${c.name} (${c.type}): distinct=${stats.distinct_n}, min=${stats.min_v ?? "-"}, max=${stats.max_v ?? "-"}, avg=${stats.avg_v != null ? Number(stats.avg_v).toFixed(3) : "-"}, top: ${topStr}`
        );
      }
      return text(parts.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "query_sql",
  {
    title: "Run SQL Query",
    description:
      "Execute a READ-ONLY SQLite SELECT/WITH query over the loaded tables. Supports JOINs across loaded files, GROUP BY, window functions.",
    inputSchema: {
      query: z.string().describe('SQLite query, e.g. SELECT category, SUM(revenue) AS total FROM sales GROUP BY category'),
    },
  },
  async ({ query }) => {
    try {
      assertReadOnly(query);
      const rows = db.prepare(query).all() as any[];
      if (rows.length === 0) return text("Query returned 0 rows.");
      const headers = Object.keys(rows[0]);
      const maxRows = Math.min(rows.length, 500);
      const lines = [headers.join(" | "), "-".repeat(Math.min(120, Math.max(10, headers.join(" | ").length)))];
      for (const r of rows.slice(0, maxRows)) {
        lines.push(headers.map((h) => String(r[h] ?? "NULL")).join(" | "));
      }
      if (rows.length > maxRows) lines.push(`… (${rows.length - maxRows} more rows hidden)`);
      return text(`${rows.length} row(s):\n${lines.join("\n")}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "summarize_data",
  {
    title: "Summarize Data",
    description: "Quick aggregate (SUM/AVG/COUNT/MIN/MAX) over a numeric column, optionally grouped by a category column.",
    inputSchema: {
      table_name: z.string(),
      value_column: z.string(),
      group_by: z.string().optional(),
      agg: z.enum(["SUM", "AVG", "COUNT", "MIN", "MAX"]).default("SUM"),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  async ({ table_name, value_column, group_by, agg, limit }) => {
    try {
      assertSafeIdentifier(table_name);
      assertSafeIdentifier(value_column);
      let q: string;
      if (group_by) {
        assertSafeIdentifier(group_by);
        q = `SELECT "${group_by}" AS grp, ${agg}("${value_column}") AS val FROM "${table_name}" GROUP BY 1 ORDER BY 2 DESC`;
      } else {
        q = `SELECT ${agg}("${value_column}") AS val FROM "${table_name}"`;
      }
      const rows = db.prepare(q).all() as any[];
      if (rows.length === 0) return text("No data.");
      const out = rows
        .slice(0, limit)
        .map((r) => `${group_by ? String(r.grp) : agg}: ${typeof r.val === "number" ? Number(r.val).toFixed(4) : String(r.val)}`);
      return text(
        `${agg}(${value_column})${group_by ? ` BY ${group_by}` : ""}:\n${out.join("\n")}${rows.length > limit ? `\n… ${rows.length - limit} more groups` : ""}`
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "generate_formula",
  {
    title: "Generate Spreadsheet Formula",
    description: "Translate a plain-English calculation request into Excel / Google Sheets formula patterns.",
    inputSchema: {
      request: z.string().describe("Plain-English calculation, e.g. 'average revenue where region is Lahore'"),
      sheet_context: z.string().optional().describe("Column layout context, e.g. 'A=Region B=Product C=Revenue D=Date'"),
    },
  },
  async ({ request, sheet_context }) => {
    const ctxLine = sheet_context ? `\nYour sheet layout: ${sheet_context}\n` : "";
    return text(
      `Request: "${request}"${ctxLine}\n` +
        `Formula patterns that usually apply:\n` +
        `- Conditional aggregation: =SUMIF(crit_range, criteria, sum_range), =AVERAGEIF(...), =COUNTIF(...)\n` +
        `- Multiple conditions: =SUMIFS(sum_range, crit_range1, crit1, crit_range2, crit2), =AVERAGEIFS(...)\n` +
        `- Lookup: =XLOOKUP(value, lookup_range, return_range, "not found") or =VLOOKUP(value, table, col_index, FALSE)\n` +
        `- Top N / ranking: =LARGE(range, k), =RANK(x, range); Google Sheets: =QUERY(data, "select A, sum(C) where A != '' group by A order by sum(C) desc limit 5")\n` +
        `- Date logic: =NETWORKDAYS(start, end), =EOMONTH(date, 0), =DATEDIF(a, b, "m")\n` +
        `- Safe division & errors: =IFERROR(expr, 0), =IFS(cond1, val1, cond2, val2, TRUE, else_val)\n\n` +
        `Tip: put criteria in cells (e.g. F1="Lahore") instead of hardcoding strings so formulas stay reusable.`
    );
  }
);

await server.connect(new StdioServerTransport());
console.error("[spreadsheet-analyst-mcp] connected over stdio");
