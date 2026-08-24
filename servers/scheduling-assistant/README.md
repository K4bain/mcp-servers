# Scheduling Assistant MCP

AI calendar assistant for **Google Calendar**: list events, create events with guest invites, query free/busy across multiple calendars, and automatically find open meeting slots within working hours.

## Setup (Google OAuth, one time)

1. In [Google Cloud Console](https://console.cloud.google.com), create a project → enable **Google Calendar API** → create **OAuth client ID** (type: Desktop app).
2. Download/keep the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
3. Generate a refresh token with the calendar scope using [oauth playground](https://developers.google.com/oauthplayground) (set your own client credentials, scope `https://www.googleapis.com/auth/calendar`, force approval prompt) or your own script. Grant access with the Google account that owns the calendar.
4. Configure:

```json
{
  "mcpServers": {
    "calendar": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/scheduling-assistant/dist/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "...apps.googleusercontent.com",
        "GOOGLE_CLIENT_SECRET": "...",
        "GOOGLE_REFRESH_TOKEN": "1//..."
      }
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `list_calendars` | All calendars + IDs + access role |
| `list_events` | Events in a time range, ordered by start |
| `create_event` | Create event; optional attendees (invites sent), location, description, all-day support |
| `delete_event` | Delete/cancel by event ID |
| `get_free_busy` | Busy intervals across any set of calendars |
| `find_available_slots` | First N slots of X minutes where ALL listed calendars are free, inside working hours |

## Example prompts

- "What's on my calendar next week?"
- "Book a 1-hour call with alice@example.com and sarah@example.com Friday between 3–5pm"
- "Find the earliest 90-minute slot next week when me and bob@acme.com are both free"
- "Cancel my 4pm meeting tomorrow"

## Notes

- Access tokens auto-refresh via the stored refresh token.
- Calendar data is private — the server only sends what's needed to Google's API.
- Outlook/Calendly support can be added as additional providers behind the same tool surface.
