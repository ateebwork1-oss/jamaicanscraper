# LinkedIn Profile Scraper on Vercel

Serverless port of [`josephlimtech/linkedin-profile-scraper-api`](https://github.com/josephlimtech/linkedin-profile-scraper-api) (MIT) — original by Joseph Lim — rewritten to run as a Vercel Function using `puppeteer-core` + `@sparticuz/chromium` instead of full `puppeteer`.

**Input:** `?url=<linkedin profile URL>` plus auth
**Output:** JSON with `userProfile`, `experiences`, `education`, `skills`

## Hard limits you need to know before deploying

1. **Cold starts are slow.** First request after inactivity: ~5–10 s just to boot Chromium.
2. **60 s function timeout** on Vercel Pro. If a profile page is slow to load, requests will die. Hobby plan's 10 s cap is useless for this.
3. **LinkedIn blocks Vercel IPs.** Vercel's egress is datacenter IPs that LinkedIn's bot-detection knows about. Your `li_at` session cookie will start throwing auth challenges much faster than it would from a residential IP. Expect to cycle cookies / accounts. Don't use your primary LinkedIn account.
4. **The DOM selectors in this scraper are from LinkedIn's 2020 layout.** LinkedIn has redesigned profile pages multiple times. Most fields will come back `null` until you update the selectors in `lib/scraper.ts` to match the current DOM. Open a profile in DevTools, inspect, update.
5. **No `keepAlive`.** Serverless containers are ephemeral, so every request does a full Chromium launch + LinkedIn auth + scrape + teardown. There's no persistent session to reuse.

You were warned. Now:

## Deploy

### 1. Get your LinkedIn session cookie (`li_at`)

- Log in to LinkedIn in a browser **with a burner account** (not your real one — this account will get rate-limited or banned eventually)
- Open DevTools → Application → Cookies → `https://www.linkedin.com`
- Copy the value of the `li_at` cookie

### 2. Deploy to Vercel

```bash
cd linkedin-scraper-vercel

# install Vercel CLI if you haven't
npm i -g vercel

# install deps locally once so vercel has package-lock.json
npm install

# login + link project
vercel login
vercel link    # creates a new project, or links to existing

# set the required env vars in Vercel
vercel env add LINKEDIN_SESSION_COOKIE_VALUE production
# (paste the li_at value when prompted)

vercel env add SCRAPER_SHARED_SECRET production
# (paste a long random string; this is your API key for calls to /api/scrape)

# ship it
vercel --prod
```

After `vercel --prod`, you'll get a URL like `https://linkedin-scraper-vercel-<hash>.vercel.app`. That's your API endpoint.

### 3. Test it

```bash
curl "https://YOUR-DEPLOYMENT.vercel.app/api/scrape?url=https://www.linkedin.com/in/williamhgates/&key=YOUR_SCRAPER_SHARED_SECRET"
```

Expected shape on success:

```json
{
  "ok": true,
  "data": {
    "userProfile": { "fullName": "...", "title": "...", "location": {...}, "url": "..." },
    "experiences": [...],
    "education": [...],
    "skills": [...]
  }
}
```

If you get `{ "ok": false, "name": "SessionExpired", ... }` — your `li_at` cookie is dead. Get a new one and `vercel env add` again, then redeploy.

If fields come back `null` but there's no error — the scraper ran, but LinkedIn's DOM has changed since the selectors in `lib/scraper.ts` were written. Inspect the profile page and update the selectors.

## Request API

### `GET /api/scrape`

**Query string:**
- `url` (required) — LinkedIn profile URL
- `key` (required unless passed as header) — value of `SCRAPER_SHARED_SECRET`

### `POST /api/scrape`

**Headers:**
- `x-api-key: <SCRAPER_SHARED_SECRET>` — auth
- `x-linkedin-cookie: <li_at_value>` — optional override of the env-var cookie, useful for rotating accounts

**Body (JSON):**
```json
{ "url": "https://www.linkedin.com/in/handle/", "sessionCookieValue": "optional_override" }
```

### Responses

| Code | Meaning |
|---|---|
| 200 | `{ ok: true, data: {...} }` |
| 400 | Missing `url` |
| 401 | Bad `SCRAPER_SHARED_SECRET` or expired LinkedIn session |
| 500 | Anything else — message in `error` |

## Calling it from n8n

See the companion workflow `LinkedIn Leads Scraper.v2.json` in the parent folder. The **Enrich via Vercel** Code node calls this endpoint per lead using `$helpers.httpRequest`, paced at ~1.5 s between calls. Before importing into n8n, replace these two placeholders in that node:

- `YOUR_VERCEL_DEPLOYMENT.vercel.app` — your actual Vercel URL
- `YOUR_VERCEL_SHARED_SECRET` — your `SCRAPER_SHARED_SECRET`

## Local dev

```bash
cp .env.example .env
# fill in LINKEDIN_SESSION_COOKIE_VALUE and SCRAPER_SHARED_SECRET
npm install
vercel dev
# then: curl "http://localhost:3000/api/scrape?url=...&key=..."
```

Note: local dev uses a **different** Chromium (your local Chrome/Chromium path), not `@sparticuz/chromium`. If you hit launch errors locally, tweak `lib/scraper.ts` to use a local `executablePath` when `process.env.VERCEL` is unset. Not wired in by default.

## Files

```
api/scrape.ts          Vercel serverless handler
lib/scraper.ts         Puppeteer scrape logic (port of src/index.ts from the zip)
lib/utils.ts           Date / text / location helpers
lib/errors.ts          SessionExpired custom error
package.json           puppeteer-core + @sparticuz/chromium
vercel.json            maxDuration: 60s, memory: 1024MB
```
