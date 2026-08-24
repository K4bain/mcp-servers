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

async function getJson<T = any>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": "regional-data-pk-mcp/1.0 (Pakistan open data assistant)", ...(headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Request failed ${res.status} for ${new URL(url).host}`);
  return (await res.json()) as T;
}

const CITY_COORDS: Record<string, [number, number]> = {
  karachi: [24.8607, 67.0011],
  lahore: [31.5497, 74.3436],
  islamabad: [33.6844, 73.0479],
  rawalpindi: [33.5651, 73.0169],
  faisalabad: [31.4187, 73.0791],
  multan: [30.1575, 71.5249],
  peshawar: [34.0151, 71.5249],
  quetta: [30.1798, 66.975],
  gujranwala: [32.1877, 74.1945],
  sialkot: [32.4945, 74.5229],
  hyderabad: [25.396, 68.3578],
  abbottabad: [34.1688, 73.2215],
  murree: [33.907, 73.3943],
  gilgit: [35.9208, 74.3144],
  skardu: [35.2971, 75.6333],
};

function resolveCoords(city: string): [number, number] {
  const key = city.trim().toLowerCase();
  const hit = CITY_COORDS[key];
  if (!hit) throw new Error(`Unknown city "${city}". Known cities: ${Object.keys(CITY_COORDS).join(", ")}.`);
  return hit;
}

interface Place {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  addresstype?: string;
  osm_id?: number;
}

async function nominatim(query: string, limit: number): Promise<Place[]> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=${limit}&countrycodes=pk&addressdetails=0`;
  return getJson<Place[]>(url);
}

const OPEN_DATA_SOURCES = [
  { name: "Pakistan Bureau of Statistics", url: "https://www.pbs.gov.pk", what: "census, inflation (CPI), trade, labour force surveys" },
  { name: "Open Data Pakistan / data.gov.pk", url: "https://data.gov.pk", what: "government datasets across ministries" },
  { name: "State Bank of Pakistan", url: "https://www.sbp.org.pk", what: "policy rate, exchange rates, banking statistics" },
  { name: "PSX (Pakistan Stock Exchange)", url: "https://dps.psx.com.pk", what: "listed companies and market data" },
  { name: "SECP", url: "https://www.secp.gov.pk", what: "company registration lookup" },
  { name: "Elections / ECP", url: "https://ecp.gov.pk", what: "election results data" },
  { name: "Punjab Land Records Authority", url: "https://plra.punjab.gov.pk", what: "property record (fard) verification" },
  { name: "NDMA", url: "https://ndma.gov.pk", what: "disaster alerts and situation reports" },
];

const server = new McpServer({ name: "regional-data-pk-mcp", version: "1.0.0" });

server.registerTool(
  "search_places",
  {
    title: "Search Places in Pakistan",
    description:
      "Search businesses, landmarks and addresses across Pakistan via OpenStreetMap (Nominatim). Good for finding companies, schools, hospitals, restaurants by name + city.",
    inputSchema: {
      query: z.string().describe('What to find, e.g. "IT company", "Systems Limited", "restaurant"'),
      city: z.string().optional().describe("City to constrain the search, e.g. Lahore"),
      max_results: z.number().int().min(1).max(20).default(8),
    },
  },
  async ({ query, city, max_results }) => {
    try {
      const q = city ? `${query} ${city}` : query;
      const results = await nominatim(q, max_results);
      if (results.length === 0) return text(`No places found for "${q}".`);
      return text(
        results
          .map((r, i) => `${i + 1}. ${r.display_name}${r.type ? `\n   Type: ${r.type} | Coords: ${r.lat}, ${r.lon}` : `\n   Coords: ${r.lat}, ${r.lon}`}`)
          .join("\n\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "geocode",
  {
    title: "Geocode Pakistani Address",
    description: "Convert a Pakistani address or place name to latitude/longitude.",
    inputSchema: { address: z.string() },
  },
  async ({ address }) => {
    try {
      const results = await nominatim(address, 1);
      if (results.length === 0) return text("Address not found.");
      return text(`${results[0].display_name}\nlat: ${results[0].lat}, lon: ${results[0].lon}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_weather",
  {
    title: "Get Weather (Pakistan)",
    description: "Current conditions + short forecast for a Pakistani city via Open-Meteo.",
    inputSchema: { city: z.string() },
  },
  async ({ city }) => {
    try {
      const [lat, lon] = resolveCoords(city);
      const r = await getJson<any>(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=3&timezone=Asia%2FKarachi`
      );
      const c = r.current ?? {};
      const d = r.daily ?? {};
      const lines = [
        `${city} now: ${c.temperature_2m}°C (feels ${c.apparent_temperature}°C), humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h`,
        ...((d.time ?? []) as string[]).map((day: string, i: number) => `  ${day}: min ${d.temperature_2m_min?.[i]}°C / max ${d.temperature_2m_max?.[i]}°C`),
      ];
      return text(lines.join("\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "get_currency_rates",
  {
    title: "Get PKR Exchange Rates",
    description: "Current exchange rates vs PKR (or from any base currency) — useful for import/export pricing.",
    inputSchema: {
      base: z.string().default("PKR").describe("Base currency code, e.g. PKR, USD"),
      symbols: z.array(z.string()).optional().describe("Limit to these codes, e.g. USD, EUR, AED, SAR"),
    },
  },
  async ({ base, symbols }) => {
    try {
      const b = base.toUpperCase();
      const r = await getJson<any>(`https://open.er-api.com/v6/latest/${b}`);
      if (r.result !== "success") throw new Error(`Rate provider error: ${JSON.stringify(r).slice(0, 200)}`);
      const rates = r.rates ?? {};
      const wanted = symbols && symbols.length > 0 ? symbols.map((s) => s.toUpperCase()) : ["USD", "EUR", "GBP", "AED", "SAR", "CNY"];
      const lines = wanted
        .filter((s) => rates[s] != null)
        .map((s) => `1 ${b} = ${rates[s]} ${s}`);
      return text(`As of ${r.time_last_update_utc}\n${lines.join("\n")}`);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "translate_text",
  {
    title: "Translate English ↔ Urdu",
    description: "Translate short texts between English and Urdu (and other pairs) via MyMemory translation API.",
    inputSchema: {
      content: z.string().min(1),
      from: z.string().default("en").describe("Source language code (en, ur, pa...)"),
      to: z.string().default("ur").describe("Target language code"),
    },
  },
  async ({ content, from, to }) => {
    try {
      if (content.length > 500) throw new Error("Keep translations under 500 characters per call.");
      const r = await getJson<any>(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(content)}&langpair=${encodeURIComponent(from)}|${encodeURIComponent(to)}`
      );
      const translated = r.responseData?.translatedText;
      if (!translated) throw new Error(r.responseDetails ?? "Translation failed");
      return text(translated);
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "list_open_data_sources",
  {
    title: "List Pakistan Open Data Sources",
    description: "Curated directory of official Pakistani data portals (statistics, finance, land records, corporate registry) with what each contains.",
    inputSchema: {},
  },
  async () => {
    return text(OPEN_DATA_SOURCES.map((s) => `- ${s.name} — ${s.what}\n  ${s.url}`).join("\n"));
  }
);

await server.connect(new StdioServerTransport());
console.error("[regional-data-pk-mcp] connected over stdio");
