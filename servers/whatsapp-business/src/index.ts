import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const GRAPH_BASE = process.env.WHATSAPP_GRAPH_VERSION
  ? `https://graph.facebook.com/${process.env.WHATSAPP_GRAPH_VERSION}`
  : "https://graph.facebook.com/v21.0";

const STORE_DIR = path.join(process.cwd(), ".whatsapp-mcp");
const MESSAGES_LOG = path.join(STORE_DIR, "messages.jsonl");

interface StoredMessage {
  direction: "inbound" | "outbound";
  from?: string;
  to?: string;
  id?: string;
  type?: string;
  text?: string;
  timestamp: string;
  raw?: unknown;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is not configured. Set it in your environment or MCP config. See README.md for setup.`
    );
  }
  return v;
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

async function graphFetch<T = any>(urlPath: string, init?: RequestInit): Promise<T> {
  const token = requireEnv("WHATSAPP_TOKEN");
  const url = urlPath.startsWith("http") ? urlPath : `${GRAPH_BASE}${urlPath}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errObj = (body as any)?.error;
    throw new Error(`WhatsApp API ${res.status}: ${errObj?.message ?? JSON.stringify(body)}`);
  }
  return body as T;
}

async function logMessage(entry: StoredMessage): Promise<void> {
  try {
    if (!existsSync(STORE_DIR)) await mkdir(STORE_DIR, { recursive: true });
    await appendFile(MESSAGES_LOG, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* logging must never break a send */
  }
}

async function readMessages(limit: number, filter?: string): Promise<StoredMessage[]> {
  if (!existsSync(MESSAGES_LOG)) return [];
  const raw = await readFile(MESSAGES_LOG, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  let messages: StoredMessage[] = lines.map((l) => {
    try {
      return JSON.parse(l) as StoredMessage;
    } catch {
      return { direction: "inbound" as const, timestamp: new Date(0).toISOString(), text: l };
    }
  });
  if (filter) {
    const f = filter.toLowerCase();
    messages = messages.filter(
      (m) =>
        m.from?.includes(filter) ||
        m.to?.includes(filter) ||
        m.text?.toLowerCase().includes(f)
    );
  }
  return messages.slice(-limit).reverse();
}

async function sendMessage(to: string, payload: Record<string, unknown>): Promise<any> {
  const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID");
  return graphFetch(`/${phoneNumberId}/messages`, {
    method: "POST",
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...payload }),
  });
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const url = new URL(req.url ?? "/", `http://localhost:${process.env.WEBHOOK_PORT ?? 8787}`);

  if (req.method === "GET" && url.searchParams.get("hub.mode") === "subscribe") {
    if (verifyToken && url.searchParams.get("hub.verify_token") === verifyToken) {
      res.writeHead(200).end(url.searchParams.get("hub.challenge") ?? "");
    } else {
      res.writeHead(403).end("verification failed");
    }
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const data = JSON.parse(body || "{}");
    const entries = data?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        for (const msg of value?.messages ?? []) {
          const textVal =
            msg?.text?.body ??
            msg?.button?.text ??
            msg?.interactive?.button_reply?.title ??
            msg?.interactive?.list_reply?.title ??
            `[${msg?.type ?? "unknown"} message]`;
          await logMessage({
            direction: "inbound",
            from: msg?.from,
            id: msg?.id,
            type: msg?.type,
            text: textVal,
            timestamp: new Date(Number(msg?.timestamp ?? 0) * 1000 || Date.now()).toISOString(),
            raw: msg,
          });
        }
        for (const status of value?.statuses ?? []) {
          await logMessage({
            direction: "outbound",
            to: status?.recipient_id,
            id: status?.id,
            type: "status",
            text: `${status?.status ?? "unknown"}${status?.errors?.[0]?.title ? ` (${status.errors[0].title})` : ""}`,
            timestamp: new Date(Number(status?.timestamp ?? 0) * 1000 || Date.now()).toISOString(),
            raw: status,
          });
        }
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));
  } catch {
    res.writeHead(400).end();
  }
}

export function startWebhookListener(): void {
  const port = Number(process.env.WEBHOOK_PORT ?? 0);
  if (!port) return;
  createServer(handleWebhook).listen(port, () => {
    console.error(`[whatsapp-business-mcp] webhook listener on http://localhost:${port}/webhook`);
  });
}

const server = new McpServer({ name: "whatsapp-business-mcp", version: "1.0.0" });

server.registerTool(
  "send_message",
  {
    title: "Send WhatsApp Message",
    description:
      "Send a free-form text message to a WhatsApp number using the WhatsApp Business Cloud API. Requires a 24-hour customer service window unless the number has replied recently; otherwise use send_template.",
    inputSchema: {
      to: z.string().describe("Recipient phone number with country code, digits only (e.g. 92300123456 (12 digits incl. country code))"),
      message: z.string().max(4096).describe("Text message body"),
      preview_url: z.boolean().optional().describe("Render the first URL in the text as a preview link"),
    },
  },
  async ({ to, message, preview_url }) => {
    try {
      const result = await sendMessage(to, { type: "text", text: { body: message, preview_url: preview_url ?? false } });
      const msgId = result?.messages?.[0]?.id;
      await logMessage({ direction: "outbound", to, id: msgId, type: "text", text: message, timestamp: new Date().toISOString() });
      return text(`Message sent to ${to}. Message ID: ${msgId ?? "unknown"}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "send_template",
  {
    title: "Send WhatsApp Template Message",
    description:
      "Send an approved template message. Use this to start conversations outside the 24-hour window. Body params fill {{1}}, {{2}}, ... placeholders in order.",
    inputSchema: {
      to: z.string().describe("Recipient phone number with country code, digits only"),
      template_name: z.string().describe("Name of the approved template"),
      language_code: z.string().default("en").describe("Template language code (e.g. en, en_US, ur)"),
      body_params: z.array(z.string()).optional().describe("Positional body parameters for {{n}} placeholders"),
    },
  },
  async ({ to, template_name, language_code, body_params }) => {
    try {
      const components =
        body_params && body_params.length > 0
          ? [
              {
                type: "body",
                parameters: body_params.map((p) => ({ type: "text", text: p })),
              },
            ]
          : undefined;
      const result = await sendMessage(to, {
        type: "template",
        template: {
          name: template_name,
          language: { code: language_code },
          ...(components ? { components } : {}),
        },
      });
      const msgId = result?.messages?.[0]?.id;
      await logMessage({
        direction: "outbound",
        to,
        id: msgId,
        type: "template",
        text: `template:${template_name}(${(body_params ?? []).join(", ")})`,
        timestamp: new Date().toISOString(),
      });
      return text(`Template "${template_name}" sent to ${to}. Message ID: ${msgId ?? "unknown"}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "send_media",
  {
    title: "Send WhatsApp Media",
    description: "Send an image, video, audio file or document by public URL.",
    inputSchema: {
      to: z.string().describe("Recipient phone number with country code, digits only"),
      media_url: z.string().url().describe("Publicly reachable HTTPS URL of the media"),
      media_type: z.enum(["image", "video", "audio", "document"]).default("image"),
      caption: z.string().max(1024).optional().describe("Caption (image/video/document only)"),
      filename: z.string().optional().describe("Filename shown for documents"),
    },
  },
  async ({ to, media_url, media_type, caption, filename }) => {
    try {
      const linkPayload: Record<string, unknown> = { link: media_url };
      if (caption) linkPayload.caption = caption;
      if (filename) linkPayload.filename = filename;
      const result = await sendMessage(to, { type: media_type, [media_type]: linkPayload });
      const msgId = result?.messages?.[0]?.id;
      await logMessage({
        direction: "outbound",
        to,
        id: msgId,
        type: media_type,
        text: caption ?? media_url,
        timestamp: new Date().toISOString(),
      });
      return text(`${media_type} sent to ${to}. Message ID: ${msgId ?? "unknown"}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_messages",
  {
    title: "Get Recent Messages",
    description:
      "Read recent inbound/outbound messages and delivery statuses recorded locally. Inbound messages arrive via the webhook listener (set WEBHOOK_PORT to enable it and point your Meta webhook at /webhook).",
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(20).describe("Max messages to return"),
      filter: z.string().optional().describe("Filter by phone number substring or text content"),
    },
  },
  async ({ limit, filter }) => {
    try {
      const msgs = await readMessages(limit, filter);
      if (msgs.length === 0) return text("No messages recorded yet.");
      const lines = msgs.map(
        (m) =>
          `[${m.timestamp}] ${m.direction.toUpperCase()} ${m.direction === "inbound" ? `from ${m.from}` : `to ${m.to}`} (${m.type}): ${m.text ?? ""}`
      );
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "mark_as_read",
  {
    title: "Mark Message as Read",
    description: "Mark an inbound message as read (blue ticks) and show typing indicator briefly.",
    inputSchema: { message_id: z.string().describe("The WhatsApp message ID (wamid...)") },
  },
  async ({ message_id }) => {
    try {
      const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID");
      await graphFetch(`/${phoneNumberId}/messages`, {
        method: "POST",
        body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id }),
      });
      return text(`Message ${message_id} marked as read.`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_business_profile",
  {
    title: "Get Business Profile",
    description: "Fetch the display name, quality rating and other metadata of the connected WhatsApp Business phone number.",
    inputSchema: {},
  },
  async () => {
    try {
      const phoneNumberId = requireEnv("WHATSAPP_PHONE_NUMBER_ID");
      const fields = "verified_name,display_phone_number,quality_rating,platform,account_mode";
      const profile = await graphFetch(`/${phoneNumberId}?fields=${fields}`);
      return text(JSON.stringify(profile, null, 2));
    } catch (e) {
      return errText(e);
    }
  }
);

startWebhookListener();

await server.connect(new StdioServerTransport());
console.error("[whatsapp-business-mcp] connected over stdio");
