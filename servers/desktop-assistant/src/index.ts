import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

const shellAllowed = /^(1|true|yes)$/i.test(process.env.ALLOW_SHELL ?? "");
const writesEnabled = /^(1|true|yes)$/i.test(process.env.ALLOW_WRITES ?? "");

function allowedRoots(): string[] {
  const raw = process.env.ALLOWED_ROOTS;
  if (raw) return raw.split(path.delimiter).map((r) => path.resolve(r.trim()));
  return [path.resolve(process.cwd())];
}

function assertWithinRoots(target: string): string {
  const resolved = path.resolve(target);
  const roots = allowedRoots();
  if (roots.length === 0) return resolved;
  const ok = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) throw new Error(`Path "${resolved}" is outside the allowed roots (${roots.join(", ")}). Set ALLOWED_ROOTS to widen access.`);
  return resolved;
}

function requireWrites(): void {
  if (!writesEnabled) throw new Error("File writes are disabled. Set ALLOW_WRITES=true in the server env to enable.");
}

async function walk(dir: string, depth: number, out: string[], maxResults: number): Promise<void> {
  if (depth < 0 || out.length >= maxResults) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxResults) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", ".git", "dist", ".next"].includes(entry.name)) continue;
      await walk(full, depth - 1, out, maxResults);
    } else {
      out.push(full);
    }
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export function runShell(command: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd" : "sh", [isWin ? "/d /s /c" : "-c", command], {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs}ms and was killed.`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.slice(0, 10_000), stderr: stderr.slice(0, 5_000), code });
    });
  });
}

const DANGEROUS = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)*[/~]/i,
  /\bformat\b/i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
  /\bdel\s+\/[sq]/i,
  /\brmdir\s+\/s/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/i,
  /\breg(\.exe)?\s+(delete|add)\b/i,
];

function assertSafeCommand(command: string): void {
  if (!shellAllowed) {
    throw new Error(
      "Shell execution is disabled by default. Set ALLOW_SHELL=true in the server env to enable run_command."
    );
  }
  for (const rx of DANGEROUS) {
    if (rx.test(command)) {
      throw new Error(`Blocked potentially destructive command pattern (${rx.source}). Refusing to run.`);
    }
  }
}

const server = new McpServer({ name: "desktop-assistant-mcp", version: "1.0.0" });

server.registerTool(
  "list_directory",
  {
    title: "List Directory",
    description: "List files and folders at a path.",
    inputSchema: { dir_path: z.string().default(".") },
  },
  async ({ dir_path }) => {
    try {
      const p = assertWithinRoots(dir_path);
      if (!existsSync(p)) return text(`Path not found: ${p}`);
      const entries = await readdir(p, { withFileTypes: true });
      if (entries.length === 0) return text("(empty directory)");
      const lines = entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()))
        .map((e) => `${e.isDirectory() ? "[DIR] " : "      "}${e.name}`);
      return text(`${p}\n${lines.join("\n")}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "search_files",
  {
    title: "Search Files by Name Pattern",
    description:
      "Recursively search filenames under a root folder (case-insensitive substring or extension match). Skips node_modules/.git/dist.",
    inputSchema: {
      pattern: z.string().describe('Filename fragment, e.g. "notes", ".pdf", "invoice-2026"'),
      root_path: z.string().default("."),
      max_results: z.number().int().min(1).max(200).default(50),
      max_depth: z.number().int().min(1).max(12).default(6),
    },
  },
  async ({ pattern, root_path, max_results, max_depth }) => {
    try {
      const root = assertWithinRoots(root_path);
      const needle = pattern.toLowerCase();
      const found: string[] = [];
      await walk(root, max_depth, found, max_results * 20);
      const matches = found.filter((f) => f.toLowerCase().includes(needle)).slice(0, max_results);
      if (matches.length === 0) return text(`No files matching "${pattern}" under ${root}.`);
      return text(`${matches.length} match(es):\n${matches.join("\n")}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "read_file",
  {
    title: "Read File",
    description: "Read a UTF-8 text file (capped).",
    inputSchema: {
      file_path: z.string(),
      max_bytes: z.number().int().min(100).max(1_000_000).default(100_000),
    },
  },
  async ({ file_path, max_bytes }) => {
    try {
      const p = assertWithinRoots(file_path);
      const info = await stat(p);
      if (!info.isFile()) return errText(new Error(`Not a regular file: ${p}`));
      const content = await readFile(p, "utf8");
      const truncated = content.length > max_bytes;
      return text(truncated ? `${content.slice(0, max_bytes)}\n… [truncated]` : content);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "write_file",
  {
    title: "Write File",
    description: "Create or overwrite a text file. Requires ALLOW_WRITES=true.",
    inputSchema: {
      file_path: z.string(),
      content: z.string(),
      create_dirs: z.boolean().default(true),
    },
  },
  async ({ file_path, content, create_dirs }) => {
    try {
      requireWrites();
      const p = assertWithinRoots(file_path);
      if (create_dirs) await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content, "utf8");
      return text(`Wrote ${Buffer.byteLength(content)} bytes to ${p}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "system_status",
  {
    title: "System Status",
    description: "OS, CPU, memory, uptime and network interfaces summary of this machine.",
    inputSchema: {},
  },
  async () => {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const lines = [
        `Host:     ${os.hostname()} (${process.platform} ${os.release()})`,
        `Uptime:   ${(os.uptime() / 3600).toFixed(1)} hours`,
        `CPU:      ${os.cpus()[0]?.model ?? "?"} × ${os.cpus().length} cores — load avg ${os.loadavg().map((l) => l.toFixed(2)).join(", ")}`,
        `Memory:   ${((totalMem - freeMem) / 1024 ** 3).toFixed(2)} GB used / ${(totalMem / 1024 ** 3).toFixed(2)} GB total`,
        `Node:     ${process.version}`,
      ];
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "run_command",
  {
    title: "Run Shell Command",
    description:
      "Execute a shell command on this machine. DISABLED unless ALLOW_SHELL=true. Destructive patterns (rm -rf /, format, shutdown, registry edits…) are blocked; output capped; hard timeout enforced.",
    inputSchema: {
      command: z.string().min(1),
      timeout_ms: z.number().int().min(1000).max(120_000).default(30_000),
    },
  },
  async ({ command, timeout_ms }) => {
    try {
      assertSafeCommand(command);
      const r = await runShell(command, timeout_ms);
      const parts = [`exit code: ${r.code}`];
      if (r.stdout.trim()) parts.push(`--- stdout ---\n${r.stdout.trim()}`);
      if (r.stderr.trim()) parts.push(`--- stderr ---\n${r.stderr.trim()}`);
      return text(parts.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "open_in_vscode",
  {
    title: "Open in VS Code",
    description: "Open a file or folder in Visual Studio Code (requires 'code' CLI on PATH).",
    inputSchema: { target: z.string() },
  },
  async ({ target }) => {
    try {
      const p = assertWithinRoots(target);
      const r = await runShell(`code "${p}"`, 10_000);
      if (r.code !== 0 && r.stderr.includes("not recognized")) {
        return errText(new Error("'code' CLI not on PATH. In VS Code run 'Shell Command: Install code command in PATH'."));
      }
      return text(`Opened ${p} in VS Code (exit ${r.code}).`);
    } catch (e) {
      return errText(e);
    }
  }
);

await server.connect(new StdioServerTransport());
console.error(
  `[desktop-assistant-mcp] connected over stdio (shell=${shellAllowed ? "ON" : "off"}, writes=${writesEnabled ? "ON" : "off"}, roots=${allowedRoots().join("; ")})`
);
