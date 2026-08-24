import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const QUEUE_FILE = path.join(process.cwd(), ".social-media-mcp", "scheduled.json");

type Platform = "twitter" | "linkedin" | "facebook" | "instagram";

interface ScheduledPost {
  id: string;
  platform: Platform;
  text: string;
  image_url?: string;
  scheduled_at: string;
  status: "pending" | "posted" | "cancelled" | "failed";
  posted_id?: string;
  error?: string;
}

function env(name: string): string | undefined {
  return process.env[name];
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

function connectedPlatforms(): Platform[] {
  const c: Platform[] = [];
  if (env("TWITTER_BEARER_TOKEN")) c.push("twitter");
  if (env("LINKEDIN_ACCESS_TOKEN") && env("LINKEDIN_MEMBER_URN")) c.push("linkedin");
  if (env("FACEBOOK_PAGE_TOKEN") && env("FACEBOOK_PAGE_ID")) c.push("facebook");
  if (env("INSTAGRAM_BUSINESS_ACCOUNT_ID") && (env("FACEBOOK_PAGE_TOKEN") || env("INSTAGRAM_ACCESS_TOKEN"))) c.push("instagram");
  return c;
}

async function api<T = any>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const bodyText = await res.text();
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = { raw: bodyText };
  }
  if (!res.ok) {
    const msg =
      body?.errors?.[0]?.message ??
      body?.error?.message ??
      body?.message ??
      bodyText.slice(0, 300);
    throw new Error(`API ${res.status}: ${msg}`);
  }
  return body;
}

async function postToTwitter(textContent: string): Promise<string> {
  const token = requireToken("TWITTER_OAUTH_TOKEN");
  const r = await api<{ data?: { id: string } }>("https://api.twitter.com/2/tweets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: textContent.slice(0, 280) }),
  });
  return r.data?.id ?? "posted";
}

async function postToLinkedIn(textContent: string, imageUrl?: string): Promise<string> {
  const token = requireToken("LINKEDIN_ACCESS_TOKEN");
  const memberUrn = requireToken("LINKEDIN_MEMBER_URN");
  const author = memberUrn.startsWith("urn:") ? memberUrn : `urn:li:person:${memberUrn}`;
  let media: Record<string, unknown> | undefined;
  if (imageUrl) {
    const register = await api<{ value: { uploadUrl: string; asset: string } }>(
      "https://api.linkedin.com/rest/images?action=initializeUpload",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "LinkedIn-Version": "202405",
          "Content-Type": "application/json",
          "X-Restli-Protocol-Version": "2.0.0",
        },
        body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
      }
    );
    await fetch(register.value.uploadUrl, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: await (await fetch(imageUrl)).arrayBuffer(),
    });
    media = {
      media: register.value.asset,
      title: { text: textContent.slice(0, 200) },
    };
  }
  const payload = {
    author,
    commentary: textContent,
    visibility: "PUBLIC",
    ...(media
      ? { content: { media } }
      : {}),
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
  };
  const res = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": "202405",
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(payload),
  });
  const postId = res.headers.get("x-restli-id");
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LinkedIn post failed ${res.status}: ${t.slice(0, 300)}`);
  }
  return postId ?? "posted";
}

function requireToken(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} is not set. See README.md for setup.`);
  return v;
}

async function postToFacebook(textContent: string, imageUrl?: string): Promise<string> {
  const pageToken = requireToken("FACEBOOK_PAGE_TOKEN");
  const pageId = requireToken("FACEBOOK_PAGE_ID");
  const endpoint = imageUrl ? `https://graph.facebook.com/v21.0/${pageId}/photos` : `https://graph.facebook.com/v21.0/${pageId}/feed`;
  const params = new URLSearchParams({ access_token: pageToken });
  if (imageUrl) {
    params.set("url", imageUrl);
    params.set("caption", textContent);
  } else {
    params.set("message", textContent);
  }
  const result = await api<{ post_id?: string; id: string }>(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  return result.post_id ?? result.id;
}

async function postToInstagram(imageUrl: string | undefined, caption: string): Promise<string> {
  if (!imageUrl) throw new Error("Instagram requires an image_url for posts.");
  const igUserId = requireToken("INSTAGRAM_BUSINESS_ACCOUNT_ID");
  const token = env("FACEBOOK_PAGE_TOKEN") ?? env("INSTAGRAM_ACCESS_TOKEN")!;
  const container = await api<{ id: string }>(`https://graph.facebook.com/v21.0/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl, caption, access_token: token }),
  });
  const publish = await api<{ id: string }>(`https://graph.facebook.com/v21.0/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: container.id, access_token: token }),
  });
  return publish.id;
}

export async function executePost(platform: Platform, textContent: string, imageUrl?: string): Promise<string> {
  switch (platform) {
    case "twitter":
      return postToTwitter(textContent);
    case "linkedin":
      return postToLinkedIn(textContent, imageUrl);
    case "facebook":
      return postToFacebook(textContent, imageUrl);
    case "instagram":
      return postToInstagram(imageUrl, textContent);
  }
}

async function loadQueue(): Promise<ScheduledPost[]> {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    return JSON.parse(await readFile(QUEUE_FILE, "utf8")) as ScheduledPost[];
  } catch {
    return [];
  }
}

async function saveQueue(q: ScheduledPost[]): Promise<void> {
  await mkdir(path.dirname(QUEUE_FILE), { recursive: true });
  await writeFile(QUEUE_FILE, JSON.stringify(q, null, 2), "utf8");
}

let schedulerRunning = false;

export function startScheduler(): void {
  if (schedulerRunning) return;
  schedulerRunning = true;
  setInterval(async () => {
    try {
      const q = await loadQueue();
      const now = Date.now();
      let dirty = false;
      for (const item of q) {
        if (item.status === "pending" && new Date(item.scheduled_at).getTime() <= now) {
          try {
            item.posted_id = await executePost(item.platform, item.text, item.image_url);
            item.status = "posted";
          } catch (e) {
            item.status = "failed";
            item.error = e instanceof Error ? e.message : String(e);
          }
          dirty = true;
        }
      }
      if (dirty) await saveQueue(q);
    } catch {
      /* scheduler tick must never crash the process */
    }
  }, 30_000).unref();
}

const platformEnum = z.enum(["twitter", "linkedin", "facebook", "instagram"]);

const server = new McpServer({ name: "social-media-manager-mcp", version: "1.0.0" });

server.registerTool(
  "list_connected_platforms",
  {
    title: "List Connected Platforms",
    description: "Show which social platforms have credentials configured in this server's environment.",
    inputSchema: {},
  },
  async () => {
    const c = connectedPlatforms();
    if (c.length === 0)
      return text(
        "No platforms configured. Set env vars: TWITTER_OAUTH_TOKEN, LINKEDIN_ACCESS_TOKEN + LINKEDIN_MEMBER_URN, FACEBOOK_PAGE_TOKEN + FACEBOOK_PAGE_ID, INSTAGRAM_BUSINESS_ACCOUNT_ID."
      );
    return text(`Connected platforms: ${c.join(", ")}`);
  }
);

server.registerTool(
  "post_now",
  {
    title: "Post Now",
    description: "Immediately publish a text post (optionally with an image URL) to one social platform.",
    inputSchema: {
      platform: platformEnum.describe("Target platform"),
      text: z.string().min(1).max(5000).describe("Post text/caption"),
      image_url: z.string().url().optional().describe("Image URL (required for Instagram, optional elsewhere)"),
    },
  },
  async ({ platform, text: postText, image_url }) => {
    try {
      const id = await executePost(platform, postText, image_url);
      return text(`Posted to ${platform}. Post ID: ${id}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "schedule_post",
  {
    title: "Schedule Post",
    description:
      "Queue a post for later publishing. The background scheduler publishes pending posts when their time arrives while this MCP server process is running.",
    inputSchema: {
      platform: platformEnum,
      text: z.string().min(1).max(5000),
      scheduled_at: z.string().describe("ISO 8601 datetime, e.g. 2026-09-15T09:00:00+05:00"),
      image_url: z.string().url().optional(),
    },
  },
  async ({ platform, text: postText, scheduled_at, image_url }) => {
    try {
      const when = new Date(scheduled_at);
      if (isNaN(when.getTime())) throw new Error(`Invalid datetime: ${scheduled_at}`);
      const q = await loadQueue();
      const id = `${platform}-${Date.now().toString(36)}`;
      q.push({ id, platform, text: postText, image_url, scheduled_at: when.toISOString(), status: "pending" });
      await saveQueue(q);
      return text(`Scheduled ${platform} post "${id}" for ${when.toISOString()}.`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "list_scheduled",
  {
    title: "List Scheduled Posts",
    description: "Show all queued and recently processed posts with their statuses.",
    inputSchema: {},
  },
  async () => {
    try {
      const q = await loadQueue();
      if (q.length === 0) return text("No posts queued yet.");
      const lines = q.map(
        (p) =>
          `[${p.id}] ${p.status.toUpperCase()} ${p.platform} @ ${p.scheduled_at} — ${p.text.slice(0, 80)}${p.error ? ` — ERROR: ${p.error}` : ""}`
      );
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "cancel_post",
  {
    title: "Cancel Scheduled Post",
    description: "Cancel a still-pending scheduled post by ID.",
    inputSchema: { post_id: z.string().describe("The scheduled post ID from list_scheduled") },
  },
  async ({ post_id }) => {
    try {
      const q = await loadQueue();
      const item = q.find((p) => p.id === post_id);
      if (!item) throw new Error(`No scheduled post found with ID ${post_id}`);
      if (item.status !== "pending") throw new Error(`Post ${post_id} is already ${item.status}, cannot cancel.`);
      item.status = "cancelled";
      await saveQueue(q);
      return text(`Cancelled post ${post_id}.`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_insights",
  {
    title: "Get Post Insights",
    description: "Fetch public engagement metrics for a single post. Supported: twitter, facebook, instagram.",
    inputSchema: {
      platform: platformEnum,
      post_id: z.string().describe("Platform post/tweet ID"),
    },
  },
  async ({ platform, post_id }) => {
    try {
      if (platform === "twitter") {
        const token = requireToken("TWITTER_BEARER_TOKEN");
        const r = await api<any>(`https://api.twitter.com/2/tweets/${post_id}?tweet.fields=public_metrics`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        return text(JSON.stringify(r.data?.public_metrics ?? r.data ?? r, null, 2));
      }
      if (platform === "facebook" || platform === "instagram") {
        const token =
          platform === "facebook"
            ? requireToken("FACEBOOK_PAGE_TOKEN")
            : (env("FACEBOOK_PAGE_TOKEN") ?? env("INSTAGRAM_ACCESS_TOKEN"))!;
        const fields =
          platform === "facebook"
            ? "likes.summary(true),comments.summary(true),shares"
            : "like_count,comments_count";
        const r = await api<any>(`https://graph.facebook.com/v21.0/${post_id}?fields=${fields}&access_token=${encodeURIComponent(token)}`, {});
        return text(JSON.stringify(r, null, 2));
      }
      return errText(new Error(`Insights not supported yet for ${platform}.`));
    } catch (e) {
      return errText(e);
    }
  }
);

startScheduler();

await server.connect(new StdioServerTransport());
console.error("[social-media-manager-mcp] connected over stdio");
