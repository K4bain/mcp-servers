# Social Media Manager MCP

One AI interface to post, schedule, and analyze content across **X (Twitter), LinkedIn, Facebook Pages, and Instagram**.

## Setup

Add the server to your MCP client and set env vars only for the platforms you use:

| Platform | Required env vars |
|----------|-------------------|
| X (Twitter) | `TWITTER_OAUTH_TOKEN` (write, OAuth 2.0 user context), `TWITTER_BEARER_TOKEN` (read insights) |
| LinkedIn | `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_MEMBER_URN` (e.g. `urn:li:person:xxxx` or just the ID) |
| Facebook Page | `FACEBOOK_PAGE_TOKEN`, `FACEBOOK_PAGE_ID` |
| Instagram Business | `INSTAGRAM_BUSINESS_ACCOUNT_ID` + `FACEBOOK_PAGE_TOKEN` (or `INSTAGRAM_ACCESS_TOKEN`) |

```json
{
  "mcpServers": {
    "social-media": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/social-media-manager/dist/index.js"],
      "env": {
        "LINKEDIN_ACCESS_TOKEN": "...",
        "LINKEDIN_MEMBER_URN": "urn:li:person:abc123",
        "FACEBOOK_PAGE_TOKEN": "...",
        "FACEBOOK_PAGE_ID": "123456789"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_connected_platforms` | Which platforms have credentials configured |
| `post_now` | Publish text (+ optional image) immediately |
| `schedule_post` | Queue a post for a future ISO datetime — published by the background scheduler while the server runs |
| `list_scheduled` | Queue status: pending / posted / cancelled / failed |
| `cancel_post` | Cancel a pending post |
| `get_insights` | Engagement metrics per post ID (twitter/facebook/instagram) |

## Example prompts

- "Post to LinkedIn: we're hiring two backend engineers in Lahore!"
- "Schedule an Instagram post with https://example.com/launch.jpg captioned 'New drop Friday' for next Tuesday 9am PKT"
- "Show my scheduled posts and cancel the LinkedIn one"
- "How did tweet 1789456123456 perform?"

## Notes

- Instagram requires an image URL for every post.
- The scheduler runs inside this MCP server process; posts fire while your MCP client session is alive. For 24/7 scheduling, host the server on an always-on machine.
- Respect each platform's rate limits and automation policies (especially X API tiers).
