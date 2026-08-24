import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

async function getJson<T = any>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "job-search-mcp/1.0",
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`Request failed ${res.status} for ${new URL(url).host}`);
  return (await res.json()) as T;
}

function stripHtml(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface Job {
  id: string;
  title: string;
  company: string;
  location?: string;
  remote_ok?: boolean;
  salary?: string;
  posted?: string;
  url?: string;
  source: string;
  snippet?: string;
  tags?: string;
}

async function remotiveSearch(query: string, limit: number): Promise<Job[]> {
  const r = await getJson<any>(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(query)}&limit=${limit}`);
  return ((r.jobs ?? []) as any[]).map((j) => ({
    id: `remotive-${j.id}`,
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || "Remote",
    remote_ok: true,
    salary: j.salary,
    posted: (j.publication_date ?? "").slice(0, 10),
    url: j.url,
    source: "Remotive",
    snippet: stripHtml(j.description).slice(0, 250),
  }));
}

async function arbeitnowSearch(limit: number): Promise<Job[]> {
  const r = await getJson<any>("https://www.arbeitnow.com/api/job-board-api");
  return ((r.data ?? []) as any[]).slice(0, limit).map((j, i) => ({
    id: `arbeitnow-${j.slug ?? i}`,
    title: j.title ?? "(untitled)",
    company: j.company_name ?? "?",
    location: j.location,
    remote_ok: Boolean(j.remote),
    salary: undefined,
    posted: j.created_at ? String(j.created_at).slice(0, 10) : undefined,
    url: j.url,
    source: "Arbeitnow",
    tags: Array.isArray(j.tags) ? j.tags.slice(0, 5).join(", ") : undefined,
    snippet: stripHtml(j.description).slice(0, 250),
  }));
}

const APPLICATIONS_FILE = path.join(process.cwd(), ".job-search-mcp", "applications.json");

interface Application {
  job_id: string;
  title: string;
  company: string;
  url?: string;
  status: string;
  updated_at: string;
  notes?: string;
}

async function loadApplications(): Promise<Application[]> {
  if (!existsSync(APPLICATIONS_FILE)) return [];
  try {
    return JSON.parse(await readFile(APPLICATIONS_FILE, "utf8")) as Application[];
  } catch {
    return [];
  }
}

async function saveApplications(apps: Application[]): Promise<void> {
  await mkdir(path.dirname(APPLICATIONS_FILE), { recursive: true });
  await writeFile(APPLICATIONS_FILE, JSON.stringify(apps, null, 2), "utf8");
}

const server = new McpServer({ name: "job-search-mcp", version: "1.0.0" });

server.registerTool(
  "search_jobs",
  {
    title: "Search Jobs",
    description:
      "Search live job listings across free boards (Remotive remote jobs + Arbeitnow EU board). Filter by keywords; results include links and snippets.",
    inputSchema: {
      keywords: z.string().describe("e.g. 'python developer', 'data scientist'"),
      max_results: z.number().int().min(1).max(30).default(10),
      board: z.enum(["remotive", "arbeitnow", "both"]).default("both"),
      remote_only: z.boolean().default(false),
      location_contains: z.string().optional().describe('Filter by location substring, e.g. "Karachi", "Germany"'),
    },
  },
  async ({ keywords, max_results, board, remote_only, location_contains }) => {
    try {
      let jobs: Job[] = [];
      const errors: string[] = [];
      if (board !== "arbeitnow") {
        try {
          jobs.push(...(await remotiveSearch(keywords, Math.max(max_results, 10))));
        } catch (e) {
          errors.push(`Remotive: ${e instanceof Error ? e.message : e}`);
        }
      }
      if (board !== "remotive") {
        try {
          jobs.push(...(await arbeitnowSearch(Math.max(max_results, 15))));
        } catch (e) {
          errors.push(`Arbeitnow: ${e instanceof Error ? e.message : e}`);
        }
      }
      const kw = keywords.toLowerCase();
      jobs = jobs.filter((j) => {
        const hay = `${j.title} ${j.snippet ?? ""}`.toLowerCase();
        if (!(hay.includes(kw.split(" ")[0]) || kw.split(" ").some((k) => k.length > 2 && hay.includes(k)))) return false;
        if (remote_only && !j.remote_ok) return false;
        if (location_contains && !(j.location ?? "").toLowerCase().includes(location_contains.toLowerCase())) return false;
        return true;
      });
      jobs = jobs.slice(0, max_results);
      if (jobs.length === 0) {
        const note = errors.length > 0 ? `\nBoard errors: ${errors.join("; ")}` : "";
        return text(`No matching jobs found.${note}`);
      }
      return text(
        jobs
          .map(
            (j, i) =>
              `${i + 1}. [${j.id}] ${j.title} @ ${j.company}\n   ${j.location ?? "?"}${j.remote_ok ? " (remote OK)" : ""}${j.salary ? ` — ${j.salary}` : ""}${j.posted ? ` — posted ${j.posted}` : ""}\n   ${j.url}\n   ${j.snippet}`
          )
          .join("\n\n") + (errors.length ? `\n\nNote: ${errors.join("; ")}` : "")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_job_details",
  {
    title: "Get Job Details",
    description: "Fetch the full description of one Remotive listing by numeric job ID.",
    inputSchema: { job_id: z.string().describe("Remotive numeric job ID (from search_jobs, strip 'remotive-' prefix)") },
  },
  async ({ job_id }) => {
    try {
      const r = await getJson<any>("https://remotive.com/api/remote-jobs?limit=200");
      const j = ((r.jobs ?? []) as any[]).find((x) => String(x.id) === job_id.replace(/^remotive-/, ""));
      if (!j) return text("Job not found on Remotive (it may have been removed).");
      return text(
        [
          `${j.title} @ ${j.company_name}`,
          `Location: ${j.candidate_required_location} | Posted: ${(j.publication_date ?? "").slice(0, 10)}`,
          j.salary ? `Salary: ${j.salary}` : "",
          `Apply: ${j.url}`,
          "",
          stripHtml(j.description).slice(0, 4000),
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "track_application",
  {
    title: "Track Application",
    description: "Record or update a job application in your local tracker (saved to disk).",
    inputSchema: {
      job_id: z.string(),
      title: z.string(),
      company: z.string(),
      url: z.string().optional(),
      status: z.enum(["saved", "applied", "interviewing", "offer", "rejected", "closed"]).default("applied"),
      notes: z.string().optional(),
    },
  },
  async ({ job_id, title, company, url, status, notes }) => {
    try {
      const apps = await loadApplications();
      const existing = apps.find((a) => a.job_id === job_id);
      if (existing) {
        existing.status = status;
        existing.updated_at = new Date().toISOString();
        if (notes) existing.notes = notes;
        if (url) existing.url = url;
      } else {
        apps.push({ job_id, title, company, url, status, updated_at: new Date().toISOString(), notes });
      }
      await saveApplications(apps);
      return text(`Application "${title}" @ ${company} marked as "${status}".`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "list_applications",
  {
    title: "List Applications",
    description: "Show all tracked applications with statuses.",
    inputSchema: {},
  },
  async () => {
    try {
      const apps = await loadApplications();
      if (apps.length === 0) return text("No tracked applications yet.");
      return text(
        apps.map((a) => `[${a.status.toUpperCase()}] ${a.title} @ ${a.company} (updated ${a.updated_at.slice(0, 10)})${a.notes ? `\n   Notes: ${a.notes}` : ""}`).join("\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "draft_application_message",
  {
    title: "Draft Application Message",
    description:
      "Generate a tailored cover-note skeleton connecting a candidate's background to a job's requirements (structure + talking points; your LLM client fleshes it out).",
    inputSchema: {
      job_title: z.string(),
      company: z.string(),
      candidate_background: z.string().describe("Short summary of experience/skills"),
      key_requirements: z.array(z.string()).optional().describe("Top requirements from the posting"),
      tone: z.enum(["formal", "friendly", "direct"]).default("formal"),
    },
  },
  async ({ job_title, company, candidate_background, key_requirements, tone }) => {
    const reqLines = (key_requirements ?? []).map((r) => `- ${r}: connect one concrete example from your background`).join("\n");
    const opener =
      tone === "formal"
        ? `Dear Hiring Team,\n\nI am writing to express my interest in the ${job_title} position at ${company}.`
        : tone === "direct"
          ? `Hi ${company} team,\n\nI'd like to be considered for your ${job_title} opening.`
          : `Hello!\n\nThe ${job_title} role at ${company} caught my eye.`;
    return text(
      [
        `${opener}`,
        ``,
        `Relevant background paragraph:`,
        `"${candidate_background}"`,
        ``,
        `Requirement → evidence mapping to weave in:`,
        reqLines || "- Pull the top requirements from the posting and map each to a concrete achievement.",
        ``,
        `Closing:`,
        tone === "formal"
          ? `Thank you for considering my application. I look forward to discussing how I can contribute to ${company}.`
          : `Would love to chat about where I could help at ${company}.`,
        ``,
        `Tips: keep under 200 words, name one measurable win, mirror the posting's own vocabulary.`,
      ].join("\n")
    );
  }
);

await server.connect(new StdioServerTransport());
console.error("[job-search-mcp] connected over stdio");
