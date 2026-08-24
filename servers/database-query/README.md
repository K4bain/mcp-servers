# Database Query MCP

Let AI assistants run **read-only SQL** (and optional parameterized writes) against SQLite, PostgreSQL or MySQL — natural language in, safe queries out.

## Setup

```json
{
  "mcpServers": {
    "database": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/database-query/dist/index.js"],
      "env": {
        "DB_TYPE": "postgres",
        "DATABASE_URL": "postgresql://user:password@host:5432/mydb",
        "ALLOW_WRITES": "false"
      }
    }
  }
}
```

| Backend | Env vars |
|---------|----------|
| SQLite | `DB_TYPE=sqlite`, optional `SQLITE_PATH` (defaults to in-memory) |
| PostgreSQL | `DB_TYPE=postgres`, `DATABASE_URL=postgresql://...` |
| MySQL/MariaDB | `DB_TYPE=mysql`, `DATABASE_URL=mysql://...` |

`ALLOW_WRITES=true` unlocks write statements and the `insert_row` tool. Keep it off for analytics assistants.

## Tools

| Tool | Description |
|------|-------------|
| `list_tables` | All tables in the database |
| `describe_table` | Columns, types, nullability |
| `execute_query` | Run SQL with bind params; read-only guard by default; results capped at 200 rows |
| `insert_row` | Parameterized single-record INSERT (injection-safe) |

## Example prompts

- "Show all customers from Lahore who spent over $5000 this year"
- "Total revenue by month for the orders table"
- "Which tables exist and how are customers related to orders?"
- "Add a new product: name 'Widget', price 9.99, stock 120"

## Security notes

- Read-only mode rejects any non-SELECT statement before it reaches your database.
- Identifiers are validated (`^[a-zA-Z_][a-zA-Z0-9_]*$`); values always go through bind parameters.
- Give the connection a dedicated, least-privilege DB user.
