# @neutronai/scraping-core

Tier 1 free Core for **Instagram + X/Twitter scraping via Apify** — a port of
Vajra's `ig-scrape.sh` + `tx-scrape.sh` (parity gap #6).

WebFetch/oEmbed can't read this content (Meta gates Instagram; X serves only the
React shell), so the Core calls the Apify `run-sync-get-dataset-items` endpoint.

## Optional until credentialed

The Core declares one `byo_api_key` secret (label `apify`, `required: false`).
Until the user pastes an Apify token in **admin → Integrations → Apify** (or via
the agent-native `integrations_connect` tool), the capability **no-ops** with
guidance and **never calls Apify**. The token is read per-call via the
capability-gated `SecretsAccessor`, so adding it later needs no restart.

Get a token free (~2000 results/month, no card) at
<https://apify.com> → Console → Settings → Integrations → API token.

## Surfaces (agent-native parity — one backend)

**MCP tools** (`network:browse`, audited):

| Tool | Modes |
|------|-------|
| `scrape_instagram` | `json` · `caption` · `summary` |
| `scrape_x` | `json` · `text` · `summary` · `article` (+ `thread`) |

**Chat command:** `/scrape <url> [mode] [--thread]` — auto-detects IG vs X from
the pasted URL.

## Actors

- Instagram: `apify/instagram-scraper`
- X tweets / threads / profiles: `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`
- X long-form Articles: `fastcrawler/x-twitter-article-to-markdown` (needs the
  share-tweet URL, not the bare `/i/article/<id>`)

## Layout

```
index.ts                 public barrel
src/manifest.ts          CORE_SLUG + constants + loadManifest
src/url-detect.ts        IG vs X classification + id extraction (pure)
src/apify-client.ts      Apify actor calls (token + fetch injected)
src/backend.ts           shared backend + optional-until-credentialed guard
src/tools.ts             capability-guarded MCP tools (buildTools)
src/chat-commands.ts     /scrape parser + dispatcher (pure)
src/chat-bridge.ts       createScrapingChatCommandFilter
src/wiring-production.ts  buildProductionScrapingCoreWiring
```

Run tests: `bun test cores/free/scraping/__tests__/`.
