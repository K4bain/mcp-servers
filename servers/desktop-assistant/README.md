# Desktop/Local Machine Assistant MCP

A **security-first** local assistant server: lets the AI browse files, read/write text, report system status, and (optionally) run shell commands on your machine.

## Security model

- File access is confined to `ALLOWED_ROOTS` (default: only the working directory).
- File writes and shell execution are **off by default** — enable explicitly with `ALLOW_WRITES=true` / `ALLOW_SHELL=true`.
- Destructive command patterns (`rm -rf /`, `format`, `shutdown`, `mkfs`, registry edits, raw-device writes) are hard-blocked.
- Shell output is capped and every command has a hard timeout.
- Never expose this server to the network; it is designed for stdio use by your local MCP client.

## Setup

```json
{
  "mcpServers": {
    "desktop": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/desktop-assistant/dist/index.js"],
      "env": {
        "ALLOWED_ROOTS": "C:/Users/you/Documents",
        "ALLOW_WRITES": "true"
      }
    }
  }
}
```

## Tools

| Tool | Default | Description |
|------|---------|-------------|
| `list_directory` | allowed | List a folder |
| `search_files` | allowed | Recursive filename search (skips node_modules/.git/dist) |
| `read_file` | allowed | Read UTF-8 file, size-capped |
| `write_file` | needs `ALLOW_WRITES` | Create/overwrite text file |
| `system_status` | allowed | OS/CPU/memory/uptime summary |
| `run_command` | needs `ALLOW_SHELL` | Run shell command with blocklist + timeout |
| `open_in_vscode` | allowed | Open path via the VS Code CLI |

## Example prompts

- "Find and open the meeting notes file in my Documents folder"
- "What's eating my RAM right now?"
- "Create a todo.md on my Desktop with today's tasks" *(writes enabled)*
- "Run git status in my project folder" *(shell enabled)*
