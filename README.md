# MCP Servers

A collection of **10 production-ready Model Context Protocol (MCP) servers** built in TypeScript, filling real gaps in the MCP ecosystem — from WhatsApp messaging to spreadsheet analysis, scheduling to local machine control.

Each server is an independent npm workspace using the official [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), with clear MVP boundaries, security guardrails, and per-server documentation.

## The collection

| # | Server | What it does | API keys needed |
|---|--------|--------------|-----------------|
| 1 | [whatsapp-business](servers/whatsapp-business) | Send/receive WhatsApp Business messages: text, templates, media, webhooks, history | Meta Cloud API token |
| 2 | [social-media-manager](servers/social-media-manager) | Post + schedule + insights across X, LinkedIn, Facebook Pages, Instagram | Per-platform OAuth (only what you use) |
| 3 | [spreadsheet-analyst](servers/spreadsheet-analyst) | Load CSV/TSV → in-memory SQLite: SQL queries, stats, formula generation | None (fully local) |
| 4 | [scheduling-assistant](servers/scheduling-assistant) | Google Calendar: events, invites, free/busy, auto find meeting slots | Google OAuth refresh token |
| 5 | [research-news-aggregator](servers/research-news-aggregator) | Live news search, page extraction, Wikipedia/arXiv, local summarization | None (optional NewsAPI) |
| 6 | [database-query](servers/database-query) | Read-only natural-language SQL over SQLite/Postgres/MySQL (+ gated writes) | DB connection string |
| 7 | [travel-planner](servers/travel-planner) | Flight/hotel search (Amadeus), points-vs-cash math, budgets, itineraries | Amadeus free credentials |
| 8 | [job-search](servers/job-search) | Search live job boards, track applications, draft application messages | None (free boards) |
| 9 | [regional-data-pk](servers/regional-data-pk) | Pakistan-focused: places search, weather, PKR rates, EN↔UR translation, open-data directory | None |
| 10 | [desktop-assistant](servers/desktop-assistant) | Local files + system status + shell — sandboxed roots, writes/shell off by default | None |

## Quick start

```bash
git clone https://github.com/K4bain/mcp-servers.git
cd mcp-servers
npm install
npm run build
```

Then register any server with your MCP client:

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

Every server's README documents its env vars (`credentials`), tools, example prompts, and security notes.

## Design principles

- **MVP-first**: each server implements the highest-value subset of its domain, with clean extension points.
- **Secure defaults**: read-only database mode, sandboxed file roots, disabled shell/writes until explicitly enabled, blocked destructive commands, capped outputs and timeouts.
- **Zero-key where possible**: servers #3, #5, #8, #9 work with no signups at all; others degrade gracefully with clear setup instructions when keys are missing.
- **Stdio transport**: all servers run over stdio for drop-in use with Claude Desktop / any MCP client.

## Repo layout

```
mcp-servers/
├── tsconfig.base.json      # shared TypeScript config
├── package.json            # npm workspaces root
└── servers/
    ├── whatsapp-business/
    ├── social-media-manager/
    ├── ...                 # one folder per server, each self-contained
    └── desktop-assistant/
```

## License

MIT
