# MCP Servers

**9 production-ready Model Context Protocol servers** in TypeScript — plug them into Claude Desktop or any MCP client and your AI gets real superpowers: send WhatsApp messages, schedule posts, query databases, run shell commands.

Official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) · npm workspaces · one folder per server · secure defaults everywhere.

## The collection

| Server | What it does | Keys needed |
|--------|--------------|-------------|
| **whatsapp-business** | Your AI texts customers on WhatsApp — text, media, approved templates, inbound webhooks | Meta token |
| **social-media-manager** | Post and schedule to X, LinkedIn, Facebook & Instagram from one chat; pull engagement stats | Per-platform OAuth |
| **spreadsheet-analyst** | Drop in a CSV, get SQL answers back — joins, group-bys, stats, zero setup | None |
| **scheduling-assistant** | AI books meetings: reads calendars, finds slots where everyone's free, sends invites | Google OAuth |
| **research-news-aggregator** | Live news search + article extraction + Wikipedia/arXiv + built-in summarizer | None |
| **database-query** | Ask questions in English, get SQL results from SQLite/Postgres/MySQL — read-only by default | DB URL |
| **travel-planner** | Search flights & hotels (Amadeus), decide cash vs points, budget trips, draft itineraries | Amadeus (free) |
| **job-search** | Search live job boards, track applications, draft cover notes | None |
| **desktop-assistant** | AI controls your machine — files, system status, shell — sandboxed, destructive stuff blocked | None |

## Quick start

```bash
git clone https://github.com/K4bain/mcp-servers.git
cd mcp-servers
npm install && npm run build
```

Register any server with your MCP client:

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

Each server folder has its own README with env vars, tool list, and example prompts.

## Design principles

- **Secure defaults** — read-only DB mode, sandboxed file roots, shell/writes off until you flip the flag, hard timeouts, capped outputs
- **Zero-key first** — spreadsheet-analyst, research-news-aggregator, job-search work with no signups at all
- **Graceful degradation** — missing a key? Every tool tells you exactly which env var to set

## License

MIT
