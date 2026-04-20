# Caribbean LinkedIn URL discovery (Vercel)

Given a search query like `{ country: "Jamaica", title: "CEO" }`, this endpoint returns a list of public LinkedIn profile URLs by scraping DuckDuckGo Lite search results for the dork `site:linkedin.com/in/ "Jamaica" "CEO"`.

Designed as the **Caribbean-only branch** of an n8n workflow whose main Apify pipeline works everywhere else.

**Why DDG and not SerpAPI / Google / LinkedIn search?**

- Free, no API key, no billing
- Doesn't CAPTCHA Vercel's datacenter IPs the way Google does
- No LinkedIn cookie, so your `li_at` can never get burned
- Cold starts < 1 s (no Puppeteer, no Chromium)

## Endpoint

### `GET /api/search`

| Query param | Type | Required | Notes |
|---|---|---|---|
| `country` | string | one of | e.g. `Jamaica`, `Trinidad and Tobago` |
| `title` | string | one of | e.g. `CEO`, `Marketing Director` |
| `industry` | string | one of | e.g. `Hospitality`, `Banking` |
| `extraTerms` | string | one of | raw additional dork terms |
| `limit` | number | no | default 50, max 200 |
| `key` | string | **required** | must equal `SCRAPER_SHARED_SECRET` env var |

At least one of `country / title / industry / extraTerms` is required.

### Response (200)

```json
{
  "ok": true,
  "query": "site:linkedin.com/in/ \"Jamaica\" \"CEO\"",
  "input": { "country": "Jamaica", "title": "CEO", "industry": "", "extraTerms": "", "limit": 50 },
  "count": 34,
  "urls": [
    { "url": "https://www.linkedin.com/in/jane-doe-abc123", "linkedin": "https://www.linkedin.com/in/jane-doe-abc123" },
    { "url": "https://jm.linkedin.com/in/john-smith",       "linkedin": "https://jm.linkedin.com/in/john-smith" }
  ],
  "debug": { "pages": [ { "page": 0, "offset": 0, "newUrls": 18 }, { "page": 1, "offset": 50, "newUrls": 16 } ] }
}
```

### Errors

| HTTP | Meaning |
|---|---|
| 400 | No search terms provided |
| 401 | Bad or missing `key` / `x-api-key` |
| 500 | `SCRAPER_SHARED_SECRET` not configured on Vercel |
| 502 | DDG returned non-200 or failed mid-pagination (partial count in body) |

## Deploy

### 1. Vercel env vars

In your Vercel project settings → Environment Variables:

- `SCRAPER_SHARED_SECRET` = long random string (e.g. `openssl rand -hex 32`)

That's the only env var you need. No LinkedIn cookie, no API keys.

### 2. Deploy

If you've already connected the GitHub repo to Vercel (which you have — `ateebwork1-oss/jamaicanscraper`), a `git push` to `main` auto-redeploys. Otherwise:

```bash
npm install
vercel --prod
```

### 3. Test

```bash
curl "https://<your-vercel-url>/api/search?country=Jamaica&title=CEO&limit=20&key=YOUR_SHARED_SECRET"
```

Expected: `ok: true` with a `urls` array of ~15–20 LinkedIn profile URLs.

## Calling it from n8n

The companion workflow `LinkedIn Leads Scraper.v3.json` (in the parent folder) does this:

```
Webhook
  → Detect Caribbean (Code node; checks country against CARICOM list)
  → IF country ∈ CARICOM?
       TRUE  → Vercel /api/search → normalize → Respond
       FALSE → original Apify pipeline → Respond
```

Inside the workflow, the HTTP node calling this endpoint needs two replacements:

- `YOUR_VERCEL_DEPLOYMENT.vercel.app` → your actual Vercel URL (e.g. `jamaicanscraper.vercel.app`)
- `YOUR_VERCEL_SHARED_SECRET` → the same secret you set in Vercel env vars

## Limits & caveats

1. **DDG result quality varies by country.** Jamaica, Trinidad, and Barbados index well. Smaller CARICOM members (Dominica, Saint Kitts, Montserrat) may return thin results — DDG only indexes what Google-like crawlers have reached.
2. **No emails, no titles, no company data.** This endpoint returns URLs only. Email enrichment happens downstream in your existing n8n pipeline.
3. **Rate limits.** DDG will soft-throttle if you hammer it (you'll see 200 OK but empty results). The function already sleeps 600 ms between pages. Don't call it more than a few times per minute.
4. **Max 200 URLs per call.** DDG Lite stops returning fresh results past ~200. If you need more, split the query (different titles, etc.) and merge downstream.
5. **URLs are deduped** (case-insensitive), with tracking params and trailing slashes stripped.

## Files

```
api/search.ts      DDG Lite scraper endpoint
package.json       No runtime deps — uses built-in fetch
vercel.json        30s timeout, 256MB memory
.env.example       SCRAPER_SHARED_SECRET
```

## Attribution

This repo originally began as a port of [`josephlimtech/linkedin-profile-scraper-api`](https://github.com/josephlimtech/linkedin-profile-scraper-api) (MIT). That approach was scrapped because the upstream code does per-profile detail scraping, not search, which wasn't the job. The current code is purpose-built for query → URL discovery via DDG.
