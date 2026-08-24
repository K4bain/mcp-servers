import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": "research-news-aggregator-mcp/1.0",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return res;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitSentences(input: string): string[] {
  const cleaned = input.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  return cleaned.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)?.map((s) => s.trim()).filter((s) => s.length > 2) ?? [];
}

const STOPWORDS = new Set(
  ("a,an,and,are,as,at,be,by,for,from,has,he,in,is,it,its,of,on,that,the,to,was,were,will,with,this,these,those,but,not,or,if,then,than,so,such,can,could,should,would,may,might,must,shall,do,does,did,have,had,i,you,we,they,she,his,her,their,our,your,my,me,him,them,us,who,which,what,when,where,why,how,all,any,both,each,few,more,most,other,some,no,nor,only,own,same,too,very,s,t,just,don,now,also,about,into,over,after,between,out,up,down,off,again,further,once,here,there".split(
    ","
  ))
);

export function extractiveSummary(input: string, maxSentences: number): string[] {
  const sentences = splitSentences(input);
  if (sentences.length <= maxSentences) return sentences;
  const freq = new Map<string, number>();
  for (const s of sentences) {
    for (const w of s.toLowerCase().match(/[a-z']{2,}/g) ?? []) {
      if (STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const scored = sentences.map((s, idx) => {
    const words = s.toLowerCase().match(/[a-z']{2,}/g) ?? [];
    let score = 0;
    for (const w of words) score += freq.get(w) ?? 0;
    return { idx, score: score / Math.max(6, words.length ** 0.6) };
  });
  const top = scored.sort((a, b) => b.score - a.score).slice(0, maxSentences).sort((a, b) => a.idx - b.idx);
  return top.map((t) => sentences[t.idx]);
}

interface NewsItem {
  title: string;
  link: string;
  source?: string;
  published?: string;
  snippet?: string;
}

async function googleNewsRss(query: string, limit: number, lang: string): Promise<NewsItem[]> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(lang)}&gl=US&ceid=US:${lang === "ur" ? "ur" : "en"}`;
  const xml = await (await safeFetch(url)).text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, limit);
  return items.map((m) => {
    const block = m[1];
    const pick = (tag: string) => block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "";
    const rawTitle = pick("title");
    const srcMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    return {
      title: rawTitle,
      link: pick("link"),
      source: srcMatch?.[1]?.trim() ?? undefined,
      published: pick("pubDate") || undefined,
    };
  });
}

async function newsApiSearch(query: string, limit: number): Promise<NewsItem[]> {
  const key = process.env.NEWSAPI_KEY;
  if (!key) throw new Error("NEWSAPI_KEY not configured — falling back to Google News RSS is recommended.");
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&pageSize=${limit}&sortBy=publishedAt`;
  const r: any = await (await safeFetch(url, { headers: { "X-Api-Key": key } })).json();
  if (r.status !== "ok") throw new Error(`NewsAPI error: ${r.message}`);
  return (r.articles ?? []).map((a: any) => ({
    title: a.title,
    link: a.url,
    source: a.source?.name,
    published: a.publishedAt,
    snippet: a.description ?? undefined,
  }));
}

async function hackerNewsSearch(query: string, limit: number): Promise<NewsItem[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`;
  const r: any = await (await safeFetch(url)).json();
  return (r.hits ?? []).map((h: any) => ({
    title: h.title ?? h.story_title ?? "(comment)",
    link: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
    source: "Hacker News",
    published: h.created_at ? new Date(h.created_at).toISOString().slice(0, 10) : undefined,
    snippet: h.points != null ? `${h.points} points` : undefined,
  }));
}

async function wikipediaSearch(query: string, limit: number): Promise<NewsItem[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${limit}&origin=*`;
  const r: any = await (await safeFetch(url)).json();
  return ((r.query?.search ?? []) as any[]).map((s) => ({
    title: s.title,
    link: `https://en.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, "_"))}`,
    source: "Wikipedia",
    snippet: stripHtml(String(s.snippet ?? "")),
  }));
}

async function arxivSearch(query: string, limit: number): Promise<NewsItem[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}&sortBy=relevance`;
  const xml = await (await safeFetch(url)).text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map((m) => {
    const b = m[1];
    const pick = (tag: string) => b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? "";
    return {
      title: pick("title").replace(/\s+/g, " "),
      link: pick("id"),
      source: "arXiv",
      published: pick("published").slice(0, 10),
      snippet: pick("summary").replace(/\s+/g, " ").slice(0, 300),
    };
  });
}

const server = new McpServer({ name: "research-news-aggregator-mcp", version: "1.0.0" });

server.registerTool(
  "search_news",
  {
    title: "Search News",
    description:
      "Search current news headlines. Uses free Google News RSS by default; NEWSAPI_KEY enables the richer NewsAPI; source='hacker_news' searches tech discussions.",
    inputSchema: {
      query: z.string().min(1),
      max_results: z.number().int().min(1).max(30).default(8),
      source: z.enum(["google_news", "newsapi", "hacker_news"]).default("google_news"),
      language: z.string().default("en").describe("Language code for Google News, e.g. en, ur"),
    },
  },
  async ({ query, max_results, source, language }) => {
    try {
      let items: NewsItem[];
      if (source === "newsapi" && process.env.NEWSAPI_KEY) items = await newsApiSearch(query, max_results);
      else if (source === "hacker_news") items = await hackerNewsSearch(query, max_results);
      else items = await googleNewsRss(query, max_results, language);
      if (items.length === 0) return text(`No results for "${query}".`);
      return text(
        items
          .map((it, i) => `${i + 1}. ${it.title}\n   ${it.link}${it.source ? `\n   Source: ${it.source}${it.published ? ` (${it.published})` : ""}` : it.published ? ` (${it.published})` : ""}`)
          .join("\n\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "fetch_url_content",
  {
    title: "Fetch URL Content",
    description: "Download a web page or article and return its readable text with HTML stripped.",
    inputSchema: {
      url: z.string().url(),
      max_chars: z.number().int().min(200).max(50_000).default(8000),
    },
  },
  async ({ url, max_chars }) => {
    try {
      const res = await safeFetch(url);
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html") && !contentType.includes("text")) {
        return text(`Non-HTML resource (${contentType || "unknown type"}), ${res.headers.get("content-length") ?? "?"} bytes.`);
      }
      const html = await res.text();
      const article = stripHtml(html);
      const body =
        article.length > max_chars
          ? `${article.slice(0, max_chars)}\n… [truncated, ${article.length - max_chars} more chars]`
          : article;
      return text(body || "(empty page)");
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "summarize_text",
  {
    title: "Summarize Text",
    description:
      "Local extractive summarization — picks the most information-dense sentences from a longer text. No external AI needed.",
    inputSchema: {
      content: z.string().min(50).describe("Text to summarize"),
      max_sentences: z.number().int().min(1).max(15).default(5),
    },
  },
  async ({ content, max_sentences }) => {
    try {
      const picked = extractiveSummary(content, max_sentences);
      if (picked.length === 0) return text("(nothing to summarize)");
      return text(picked.map((s, i) => `${i + 1}. ${s}`).join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "search_wikipedia",
  {
    title: "Search Wikipedia",
    description: "Full-text search across English Wikipedia; returns titles, snippets and links.",
    inputSchema: {
      query: z.string(),
      max_results: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ query, max_results }) => {
    try {
      const items = await wikipediaSearch(query, max_results);
      if (items.length === 0) return text("No Wikipedia matches.");
      return text(items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.link}\n   ${it.snippet}`).join("\n\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "search_arxiv",
  {
    title: "Search arXiv Papers",
    description: "Search academic preprints on arXiv (CS, physics, math, etc.) by keyword.",
    inputSchema: {
      query: z.string(),
      max_results: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ query, max_results }) => {
    try {
      const items = await arxivSearch(query, max_results);
      if (items.length === 0) return text("No arXiv matches.");
      return text(items.map((it, i) => `${i + 1}. ${it.title} (${it.published})\n   ${it.link}\n   ${it.snippet}…`).join("\n\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

await server.connect(new StdioServerTransport());
console.error("[research-news-aggregator-mcp] connected over stdio");
