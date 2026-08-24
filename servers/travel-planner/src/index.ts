import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const AMADEUS_HOST = process.env.AMADEUS_ENV === "production"
  ? "https://api.amadeus.com"
  : "https://test.api.amadeus.com";

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function errText(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Register for free Amadeus Self-Service credentials — see README.md.`);
  return v;
}

async function getAmadeusToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch(`${AMADEUS_HOST}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: requireEnv("AMADEUS_CLIENT_ID"),
      client_secret: requireEnv("AMADEUS_CLIENT_SECRET"),
    }).toString(),
  });
  const body: any = await res.json();
  if (!res.ok) throw new Error(`Amadeus auth failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  cachedToken = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 1799) * 1000 };
  return cachedToken.token;
}

export async function amadeus<T = any>(urlPath: string, params?: Record<string, string>): Promise<T> {
  const token = await getAmadeusToken();
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  const res = await fetch(`${AMADEUS_HOST}${urlPath}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const bodyText = await res.text();
  let body: any;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`Amadeus returned non-JSON (${res.status}): ${bodyText.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg = body?.errors?.map((e: any) => e.detail ?? e.title).join("; ") ?? bodyText.slice(0, 300);
    throw new Error(`Amadeus ${res.status}: ${msg}`);
  }
  return body as T;
}

function fmtDuration(iso: string | undefined): string {
  if (!iso) return "?";
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return iso;
  return `${m[1] ? `${m[1]}h` : ""}${m[2] ? ` ${m[2]}m` : ""}`.trim();
}

function money(v: string | number | undefined, currency?: string): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  if (n == null || isNaN(n)) return "?";
  return `${currency ?? ""}${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

const server = new McpServer({ name: "travel-planner-mcp", version: "1.0.0" });

server.registerTool(
  "get_airport_code",
  {
    title: "Find Airport/City Code",
    description: "Resolve a city or airport name to its IATA code via Amadeus reference data.",
    inputSchema: {
      keyword: z.string().min(2).describe("City or airport name, e.g. 'Lahore', 'Paris'"),
      max_results: z.number().int().min(1).max(10).default(5),
    },
  },
  async ({ keyword, max_results }) => {
    try {
      const r = await amadeus<any>("/v1/reference-data/locations", {
        subType: "CITY,AIRPORT",
        keyword,
        "page[limit]": String(max_results),
      });
      const items = r.data ?? [];
      if (items.length === 0) return text(`No match for "${keyword}".`);
      return text(
        items
          .map((it: any) => `${it.iataCode} — ${it.name} (${it.address?.cityName ?? "?"}, ${it.address?.countryName ?? "?"}) [${it.subtype}]`)
          .join("\n")
      );
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "search_flights",
  {
    title: "Search Flights",
    description: "Search flight offers between two IATA airport codes on a date (one-way or round-trip).",
    inputSchema: {
      origin: z.string().length(3).describe("Origin IATA code, e.g. LHE"),
      destination: z.string().length(3).describe("Destination IATA code, e.g. PAR"),
      departure_date: z.string().describe("YYYY-MM-DD"),
      return_date: z.string().optional().describe("YYYY-MM-DD for round trips"),
      adults: z.number().int().min(1).max(9).default(1),
      currency: z.string().default("USD"),
      max_results: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ origin, destination, departure_date, return_date, adults, currency, max_results }) => {
    try {
      const r = await amadeus<any>("/v2/shopping/flight-offers", {
        originLocationCode: origin.toUpperCase(),
        destinationLocationCode: destination.toUpperCase(),
        departureDate: departure_date,
        ...(return_date ? { returnDate: return_date } : {}),
        adults: String(adults),
        currencyCode: currency.toUpperCase(),
        max: String(max_results),
      });
      const carriers: Record<string, string> = {};
      for (const d of r.dictionaries?.carriers ? Object.entries(r.dictionaries.carriers) : []) {
        carriers[d[0] as string] = d[1] as string;
      }
      const offers = (r.data ?? []).slice(0, max_results);
      if (offers.length === 0)
        return text(`No flights found ${origin}→${destination} on ${departure_date}.`);
      const lines = offers.map((offer: any, i: number) => {
        const price = money(offer.price?.total, offer.price?.currency);
        const segs = offer.itineraries?.map((itin: any, j: number) => {
          const first = itin.segments?.[0];
          const last = itin.segments?.[itin.segments.length - 1];
          const stops = (itin.segments?.length ?? 1) - 1;
          const airline = carriers[first?.carrierCode ?? ""] ?? first?.carrierCode ?? "?";
          return `${j === 0 ? "OUT" : "BACK"} ${first?.departure?.iataCode}→${last?.arrival?.iataCode} dep ${first?.departure?.at} ${stops === 0 ? "nonstop" : `${stops} stop(s)`} ${fmtDuration(itin.duration)} (${airline})`;
        });
        return `${i + 1}. ${price}\n   ${segs.join("\n   ")}`;
      });
      return text(lines.join("\n\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "search_hotels",
  {
    title: "Search Hotels",
    description: "List hotels in a city with rates for given dates (availability varies in the Amadeus test environment).",
    inputSchema: {
      city_code: z.string().length(3).describe("City IATA code, e.g. LON"),
      check_in: z.string().describe("YYYY-MM-DD"),
      check_out: z.string().describe("YYYY-MM-DD"),
      adults: z.number().int().min(1).max(9).default(2),
      max_results: z.number().int().min(1).max(20).default(5),
    },
  },
  async ({ city_code, check_in, check_out, adults, max_results }) => {
    try {
      const hotelsRes = await amadeus<any>("/v1/reference-data/locations/hotels/by-city", {
        cityCode: city_code.toUpperCase(),
      });
      const hotelIds = (hotelsRes.data ?? []).slice(0, 40).map((h: any) => h.hotelId).filter(Boolean);
      if (hotelIds.length === 0) return text(`No hotels found for city code ${city_code}.`);
      const offersRes = await amadeus<any>("/v3/shopping/hotel-offers", {
        hotelIds: hotelIds.slice(0, 20).join(","),
        checkInDate: check_in,
        checkOutDate: check_out,
        adults: String(adults),
        ...(process.env.HOTEL_CURRENCY ? { currency: process.env.HOTEL_CURRENCY } : {}),
      });
      const offers = (offersRes.data ?? []).slice(0, max_results);
      if (offers.length === 0)
        return text(`Found ${(hotelsRes.data ?? []).length} hotels in ${city_code} but no rate offers for those dates (common in the test environment). Try other dates or production credentials.`);
      const lines = offers.map((o: any, i: number) => {
        const hotel = o.hotel ?? {};
        const offer = o.offers?.[0] ?? {};
        return `${i + 1}. ${hotel.name ?? "(unnamed)"} — ${money(offer.price?.total, offer.price?.currency)} total\n   ${hotel.address?.lines?.join(", ") ?? ""} ${hotel.address?.cityName ?? ""}\n   Room: ${offer.room?.typeEstimated?.category ?? "?"}, ${offer.policies?.cancellation?.description ?? "check cancellation rules"}`;
      });
      return text(lines.join("\n\n"));
    } catch (e) {
      return errText(e);
    }
  }
);

server.registerTool(
  "compare_cash_vs_points",
  {
    title: "Compare Cash vs Points",
    description:
      "Decide whether to pay cash or redeem loyalty points for a booking. Values points at your own per-point valuation.",
    inputSchema: {
      cash_price: z.number().positive().describe("Cash price of the booking"),
      points_cost: z.number().positive().describe("Points required"),
      point_value_cents: z.number().positive().default(1.2).describe("Your valuation of one point in cents"),
      taxes_fees: z.number().min(0).default(0).describe("Cash co-pay when redeeming points"),
    },
  },
  async ({ cash_price, points_cost, point_value_cents, taxes_fees }) => {
    const pointsValue = (points_cost * point_value_cents) / 100 + taxes_fees;
    const better = pointsValue < cash_price ? "POINTS" : cash_price < pointsValue ? "CASH" : "EITHER";
    const savings = Math.abs(cash_price - pointsValue);
    return text(
      [
        `Cash price:            $${cash_price.toFixed(2)}`,
        `Points redemption:     ${points_cost.toLocaleString()} pts ≈ $${pointsValue.toFixed(2)} (incl. $${taxes_fees.toFixed(2)} co-pay @ ${(point_value_cents).toFixed(2)}¢/pt)`,
        ``,
        `Better option: ${better}${savings > 0 ? ` — saves about $${savings.toFixed(2)}` : ""}`,
        `Effective value per point if redeemed: ${((cash_price - taxes_fees) / points_cost * 100).toFixed(2)}¢`,
      ].join("\n")
    );
  }
);

server.registerTool(
  "estimate_trip_budget",
  {
    title: "Estimate Trip Budget",
    description: "Estimate a total trip budget from component costs.",
    inputSchema: {
      flights_total: z.number().min(0).default(0),
      nights: z.number().int().min(0).default(3),
      nightly_rate: z.number().min(0).default(80),
      daily_food_per_person: z.number().min(0).default(30),
      daily_local_transport: z.number().min(0).default(10),
      activities_total: z.number().min(0).default(100),
      travelers: z.number().int().min(1).default(1),
      buffer_percent: z.number().min(0).max(50).default(10),
    },
  },
  async ({ flights_total, nights, nightly_rate, daily_food_per_person, daily_local_transport, activities_total, travelers, buffer_percent }) => {
    const lodging = nights * nightly_rate;
    const food = nights * daily_food_per_person * travelers;
    const transport = nights * daily_local_transport * travelers;
    const subtotal = flights_total * travelers + lodging + food + transport + activities_total;
    const buffer = subtotal * (buffer_percent / 100);
    const total = subtotal + buffer;
    return text(
      [
        `Trip budget estimate (${travelers} traveler(s), ${nights} nights):`,
        `- Flights:       $${(flights_total * travelers).toFixed(2)}`,
        `- Lodging:       $${lodging.toFixed(2)}`,
        `- Food:          $${food.toFixed(2)}`,
        `- Local transit: $${transport.toFixed(2)}`,
        `- Activities:    $${activities_total.toFixed(2)}`,
        `Subtotal:        $${subtotal.toFixed(2)}`,
        `Buffer (${buffer_percent}%):  $${buffer.toFixed(2)}`,
        `TOTAL:           $${total.toFixed(2)}`,
      ].join("\n")
    );
  }
);

server.registerTool(
  "build_itinerary",
  {
    title: "Build Day-by-Day Itinerary Skeleton",
    description:
      "Generate a structured day-by-day itinerary skeleton you can refine — morning/afternoon/evening blocks with travel logistics reminders.",
    inputSchema: {
      destination: z.string(),
      days: z.number().int().min(1).max(14),
      arrival_day_notes: z.string().optional().describe("e.g. 'land at LHE 14:00'"),
      interests: z.array(z.string()).optional().describe('Themes like ["history", "food", "nature"]'),
      pace: z.enum(["relaxed", "balanced", "packed"]).default("balanced"),
    },
  },
  async ({ destination, days, arrival_day_notes, interests, pace }) => {
    const blocksPerDay = pace === "relaxed" ? 2 : pace === "packed" ? 4 : 3;
    const themes = interests && interests.length > 0 ? interests : ["sightseeing", "local food"];
    const lines: string[] = [`Itinerary skeleton: ${destination}, ${days} day(s), ${pace} pace`];
    if (arrival_day_notes) lines.push(`Day 1 note: ${arrival_day_notes}`);
    for (let d = 1; d <= days; d++) {
      lines.push(`\nDay ${d}:`);
      for (let b = 0; b < Math.min(blocksPerDay, d === 1 || d === days ? Math.max(1, blocksPerDay - 1) : blocksPerDay); b++) {
        const theme = themes[(d - 1 + b) % themes.length];
        const slot = ["Morning", "Afternoon", "Evening", "Night"][b];
        lines.push(`  ${slot}: plan around ${theme} (pick a specific spot near your base)`);
      }
    }
    lines.push(
      `\nReminders:`,
      `- Book day-trips/tickets that sell out before you go`,
      `- Check visa/passport validity and local holidays`,
      `- Save offline maps and emergency numbers for ${destination}`
    );
    return text(lines.join("\n"));
  }
);

await server.connect(new StdioServerTransport());
console.error("[travel-planner-mcp] connected over stdio");
