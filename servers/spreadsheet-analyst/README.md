# Spreadsheet/Data Analyst MCP

AI assistant for tabular data: load CSV/TSV files into an in-memory SQLite engine, then query, aggregate, and describe them with SQL. Also translates plain-English calculations into Excel/Sheets formula patterns.

## Setup

```json
{
  "mcpServers": {
    "sheets": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/spreadsheet-analyst/dist/index.js"]
    }
  }
}
```

No API keys required — everything runs locally on your machine. Data never leaves the process.

## Tools

| Tool | Description |
|------|-------------|
| `load_csv` | Load a CSV/TSV file (header row + type inference: INTEGER/REAL/TEXT) |
| `list_tables` | Tables in this session with row counts and columns |
| `describe_table` | Per-column stats: distinct count, min/max/avg, most common values |
| `query_sql` | Read-only SQLite SELECT over loaded tables (JOINs across files supported) |
| `summarize_data` | Quick SUM/AVG/COUNT/MIN/MAX, optionally grouped by a category column |
| `generate_formula` | Plain-English → Excel/Google Sheets formula guidance |

## Example prompts

- "Load sales.csv and tell me the top 3 regions by revenue"
- "In q1_sales.csv, which product category had the highest average sale?"
- "Join customers.csv with orders.csv on customer_id and show total spend per city"
- "What Excel formula averages column C only where region is Lahore?"

## Notes

- Only read-only `SELECT`/`WITH` queries are permitted.
- Tables live in memory for the session; reload after restarting your MCP client.
- For Google Sheets, export as CSV first or extend `load_csv` with the Sheets API.
