# Job Search / Recruiting MCP

Search live remote/EU job boards, inspect listings, track your applications, and draft application messages.

## Setup

```json
{
  "mcpServers": {
    "jobs": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/job-search/dist/index.js"]
    }
  }
}
```

No API keys required — uses the free **Remotive** and **Arbeitnow** public job APIs. Applications are tracked locally in `.job-search-mcp/applications.json`.

## Tools

| Tool | Description |
|------|-------------|
| `search_jobs` | Keyword search across Remotive + Arbeitnow with remote/location filters |
| `get_job_details` | Full description for a Remotive listing |
| `track_application` | Save/update application status (saved → applied → interviewing → offer/rejected) |
| `list_applications` | Your local application pipeline |
| `draft_application_message` | Cover-note skeleton: opener + requirement→evidence mapping |

## Example prompts

- "Find remote Python developer jobs paying over $50k"
- "Show me details for job 912345"
- "Track that I applied to the Acme data scientist role yesterday"
- "Draft a friendly application note for the DevOps role at Stripe — I have 4 years of Kubernetes experience"

## Notes

- Applying itself is deliberately manual (auto-submitting applications violates most boards' terms); this server gets you to the 1-click moment.
- For enterprise ATS (Greenhouse/Lever), add their public boards API as another source.
