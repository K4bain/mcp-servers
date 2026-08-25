# WhatsApp Business MCP

MCP server that lets AI assistants send and receive **WhatsApp Business Cloud API** messages: free-form text, approved templates, media, read receipts, and inbound message history.

## Setup

1. Create a Meta app with the *WhatsApp* product at [developers.facebook.com](https://developers.facebook.com).
2. Get your **access token** and **phone number ID** from the API Setup page.
3. Configure the server in your MCP client (e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "whatsapp": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/whatsapp-business/dist/index.js"],
      "env": {
        "WHATSAPP_TOKEN": "EAAG...",
        "WHATSAPP_PHONE_NUMBER_ID": "123456789012345",
        "WHATSAPP_VERIFY_TOKEN": "any-string-you-choose",
        "WEBHOOK_PORT": "8787"
      }
    }
  }
}
```

`WEBHOOK_PORT` is optional. When set, a local HTTP listener starts on `http://localhost:<port>/webhook` to receive Meta webhooks (inbound messages + delivery statuses). Expose it publicly with a tunnel (e.g. `ngrok http 8787`) and register it in your Meta app webhook settings using your verify token. Messages are stored in `.whatsapp-mcp/messages.jsonl`.

## Tools

| Tool | Description |
|------|-------------|
| `send_message` | Send free-form text (works inside the 24-hour customer service window) |
| `send_template` | Send an approved template with positional body params â€” starts new conversations |
| `send_media` | Send image/video/audio/document by URL, optional caption/filename |
| `get_messages` | Read recent message history & delivery statuses (optionally filtered) |
| `mark_as_read` | Blue-tick an inbound message |
| `get_business_profile` | Display name, quality rating, account mode of the connected number |

## Example prompts

- "Send 'Your order #1042 has shipped!' to 923XXYYYYYYY"
- "Send our menu image https://example.com/menu.jpg to 923XXYYYYYYY with caption 'Today's specials'"
- "Show me the last 10 WhatsApp messages from customers"
- "What's the quality rating of our business number?"

## Notes

- Free-form messages only work within 24h of the user's last message; use templates otherwise.
- Template names must be approved in the Meta Business Manager first.
- Respect user privacy â€” message people who opted in.
