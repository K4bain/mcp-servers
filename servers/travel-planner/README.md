# Travel & Itinerary Planner MCP

Flight and hotel search via the **Amadeus Self-Service API**, plus loyalty-points math, budget estimation, and itinerary skeletons.

## Setup

1. Register free at [developers.amadeus.com](https://developers.amadeus.com) → create an app → copy the test-environment key/secret.
2. Configure:

```json
{
  "mcpServers": {
    "travel": {
      "command": "node",
      "args": ["/path/to/mcp-servers/servers/travel-planner/dist/index.js"],
      "env": {
        "AMADEUS_CLIENT_ID": "...",
        "AMADEUS_CLIENT_SECRET": "...",
        "AMADEUS_ENV": "test"
      }
    }
  }
}
```

Set `AMADEUS_ENV=production` with production credentials for live booking data.

## Tools

| Tool | Description |
|------|-------------|
| `get_airport_code` | City/airport name → IATA code |
| `search_flights` | Live flight offers (price, times, stops, airline) one-way or round-trip |
| `search_hotels` | Hotel rates in a city for given dates |
| `compare_cash_vs_points` | Cash vs loyalty-points decision math with your own point valuation |
| `estimate_trip_budget` | Total trip budget from flights/lodging/food/transit/activities + buffer |
| `build_itinerary` | Day-by-day itinerary skeleton by theme and pace |

## Example prompts

- "Find flights from Lahore to Istanbul on Oct 12, cheapest first"
- "What's my IATA code for Paris?"
- "Compare paying $420 cash vs 38,000 points + $11 taxes for this flight"
- "Build a relaxed 5-day Tokyo itinerary focused on food and history, ~$1500 budget"

## Notes

- The Amadeus **test** environment returns limited/simulated data — great for development; switch to production keys for real bookings.
- This server searches; it does not purchase. Booking requires payment integration (PCI scope).
