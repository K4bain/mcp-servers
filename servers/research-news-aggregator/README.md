# Research/News Aggregator MCP

AI research assistant that fetches live information from the web: news search, article extraction, Wikipedia/arXiv lookup, and **local extractive summarization** (no external AI key needed).

## Setup

```json
{
  "mcpServers": {
    "research": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/research-news-aggregator/dist/index.js"],
      "env": { "NEWSAPI_KEY": "optional-for-richer-news" }
    }
  }
}
```

Works with **zero API keys** — Google News RSS, Wikipedia and arXiv are free. Set `NEWSAPI_KEY` (newsapi.org) for structured news metadata.

## Tools

| Tool | Description |
|------|-------------|
| `search_news` | Headlines from Google News RSS / NewsAPI / Hacker News |
| `fetch_url_content` | Download any page, strip HTML, return readable text |
| `summarize_text` | Extractive summary via word-frequency sentence scoring (runs locally) |
| `search_wikipedia` | Full-text Wikipedia search with snippets |
| `search_arxiv` | Academic paper search on arXiv |

## Example prompts

- "Find recent news about renewable energy investment in Pakistan and summarize the top 3 articles"
- "Fetch https://example.com/blog/post and give me a 5-sentence summary"
- "Search arXiv for retrieval-augmented generation papers from this year"
- "What does Wikipedia say about the Indus Basin irrigation system?"

## Notes

- Summarization is extractive (picks real sentences) — deterministic and free; pipe long results through your LLM for abstractive summaries.
- Respect robots.txt and publisher terms when redistributing excerpts.
