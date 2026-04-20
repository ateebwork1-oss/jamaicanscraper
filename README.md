# Caribbean LinkedIn URL discovery (Vercel)

Given a search query like `{ country: "Jamaica", title: "CEO" }`, this endpoint returns a list of public LinkedIn profile URLs.

Designed as the **Caribbean-only branch** of an n8n workflow whose main Apify pipeline works everywhere else.

## Provider chain

The function tries these providers in order until one returns URLs:

| # | Provider | Setup | Free quota | Works from Vercel? |
|---|---|---|---|---|
| 1 | **Serper.dev** (Google SERP API) | `SERPER_API_KEY` | 2,500 queries on signup, no CC | ✅ Reliable |
| 2 | **Google Custom Search** | `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` | 100/day, no CC | ✅ when configured right |
| 3 | Bing HTML scrape | none | unlimited | ⚠️ Cloudflare CAPTCHA on datacenter IPs |
| 4 | DuckDuckGo html | none | unlimited | ⚠️ Usually 403s from Vercel |
| 5 | DuckDuckGo Lite | none | unlimited | ⚠️ Usually 403s from Vercel |

**Recommended**: set `SERPER_API_KEY` and ignore the rest. The unkeyed scrapers mostly exist as a historical fallback and will almost always fail from a Vercel IP.

## Endpoint

### `GET /api/search`

| Query param | Type | Required | Notes |
|---|---|---|---|
| `country` | string | one of | e.g. `Jamaica`, `Trinidad and Tobago` |
| `title` | string | one of | e.g. `CEO`, `Marketing Director` |
| `industry` | string | one of | e.g. `Hospitality`, `Banking` |
| `extraTerms` | string | one of | raw additional dork terms |
| `limit` | number | no | default 50, max 200 |
| `key` | string | **required** | must equal `SCRAPER_SHARED_SECRET` env var (also accepted as `x-api-key` header) |

At least one of `country / title / industry / extraTerms` is required.

### Response (200)

```json
{
  "ok": true,
  "query": "site:linkedin.com/in/ \"Jamaica\" \"CEO\"",
  "input": { "country": "Jamaica", "title": "CEO", "industry": "", "extraTerms": "", "limit": 50 },
  "provider": "serper",
  "count": 34,
  "urls": [
    { "url": "https://www.linkedin.com/in/jane-doe-abc123", "linkedin": "https://www.linkedin.com/in/jane-doe-abc123" }
  ],
  "debug": { "attempts": [ { "provider": "serper", "ok": true, "urls": [ "..." ] } ] }
}
```

### Errors

| HTTP | Meaning |
|---|---|
| 400 | No search terms provided |
| 401 | Bad or missing `key` / `x-api-key` |
| 500 | `SCRAPER_SHARED_SECRET` not configured on Vercel |
| 502 | All providers failed — inspect `debug.attempts[]` for the reason |

## Deploy

### 1. Get a Serper API key (2 minutes, free)

1. Go to https://serper.dev and sign up with Google or email (no credit card).
2. Dashboard → copy your API key.

### 2. Vercel env vars

In your Vercel project → Settings → Environment Variables (apply to **Production**):

| Key | Value |
|---|---|
| `SCRAPER_SHARED_SECRET` | long random string, e.g. `openssl rand -hex 32` |
| `SERPER_API_KEY` | the key from serper.dev |

Then **Deployments → latest → Redeploy** (env var changes don't auto-redeploy).

### 3. Test

```bash
curl "https://jamaicanscraper.vercel.app/api/search?country=Jamaica&title=CEO&limit=20&key=YOUR_SHARED_SECRET"
```

Expected: `ok: true`, `provider: "serper"`, and ~15–20 LinkedIn URLs.

If you see `ok: false`, check `debug.attempts[0].error` — it will say exactly why Serper failed (bad key, quota exhausted, etc).

## Calling it from n8n

The companion workflow `LinkedIn Leads Scraper.v3.json` (in the parent folder) does this:

```
Webhook
  → Detect Caribbean (Code node; checks country against CARICOM list)
  → IF country ∈ CARICOM?
       TRUE  → Vercel /api/search → normalize → Respond
       FALSE → original Apify pipeline → Respond
```

Inside the workflow, the HTTP node calling this endpoint needs:

- URL: `https://jamaicanscraper.vercel.app/api/search` (already patched)
- Header `x-api-key`: the `SCRAPER_SHARED_SECRET` value

## Limits & caveats

1. **Serper free tier is 2,500 lifetime searches** on a new account. Each `limit` up to 100 = 1 search. Past 2,500, you need to pay or create a new account.
2. **Google CSE alternative**: if you fix your Google Cloud project and wire up `GOOGLE_API_KEY` + `GOOGLE_CSE_ID`, it'll take over automatically when Serper is missing/empty (100/day, renewable daily, free forever).
3. **No emails, no titles, no company data.** This endpoint returns URLs only. Email enrichment happens downstream in your existing n8n pipeline.
4. **Max 200 URLs per call.** Split the query across titles/industries and merge downstream if you need more.
5. **URLs are deduped** (case-insensitive), with query strings and trailing slashes stripped.

## Files

```
api/search.ts      Multi-provider LinkedIn URL search endpoint
package.json       No runtime deps — uses built-in fetch
vercel.json        30s timeout, 256MB memory
.env.example       env var template
```
