import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Caribbean LinkedIn URL discovery endpoint.
 *
 * Given { country, title, industry, limit, extraTerms } returns a deduped
 * list of LinkedIn profile URLs scraped from DuckDuckGo Lite search results
 * (site:linkedin.com/in/ "<country>" "<title>").
 *
 * NO LinkedIn cookie, NO Puppeteer. Purely HTML scrape of DDG.
 *
 * Auth: x-api-key header OR ?key=... query param must match SCRAPER_SHARED_SECRET env var.
 */

const DDG_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

// Reasonable ceilings so one request doesn't hammer DDG and blow the function timeout.
const MAX_LIMIT = 200;
const MAX_PAGES = 4;
const PAGE_SIZE = 50;
const POLITE_DELAY_MS = 600;

interface SearchInput {
  country: string;
  title: string;
  industry: string;
  extraTerms: string;
  limit: number;
}

function readInput(req: VercelRequest): SearchInput {
  const body = (req.body as any) || {};
  const pick = (name: string): string => {
    const v = (req.query[name] as string) ?? body[name] ?? "";
    return String(v || "").trim();
  };
  const limitRaw = parseInt(
    (req.query.limit as string) ?? String(body.limit ?? 50),
    10,
  );
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(limitRaw, MAX_LIMIT)
      : 50;
  return {
    country: pick("country"),
    title: pick("title"),
    industry: pick("industry"),
    extraTerms: pick("extraTerms"),
    limit,
  };
}

function buildDorkQuery(input: SearchInput): string {
  const parts: string[] = ["site:linkedin.com/in/"];
  const wrap = (s: string) => (s.includes(" ") ? `"${s}"` : s);
  if (input.country) parts.push(wrap(input.country));
  if (input.title) parts.push(wrap(input.title));
  if (input.industry) parts.push(wrap(input.industry));
  if (input.extraTerms) parts.push(input.extraTerms);
  return parts.join(" ");
}

/**
 * Pull profile URLs out of the raw DDG Lite HTML. DDG Lite renders each
 * result as a direct <a href="https://linkedin.com/in/..."> so we can match
 * greedily via regex without needing a DOM parser.
 */
function extractLinkedInUrls(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Matches https://... linkedin.com/in/<handle> (handles locale prefixes like uk.linkedin.com)
  const re =
    /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_\-%.]+(?:\/)?/gi;
  const matches = html.match(re) || [];
  for (const raw of matches) {
    let url = raw;
    try {
      const u = new URL(url);
      u.search = "";
      u.hash = "";
      u.hostname = u.hostname.toLowerCase();
      url = u.toString().replace(/\/+$/, "");
    } catch {
      url = url.replace(/\/+$/, "");
    }
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

async function fetchDDGPage(query: string, offset: number): Promise<string> {
  const params = new URLSearchParams({ q: query });
  if (offset > 0) params.set("s", String(offset));
  const url = `${DDG_ENDPOINT}?${params.toString()}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://duckduckgo.com/",
    },
  });
  if (!resp.ok) {
    throw new Error(`DDG returned HTTP ${resp.status}`);
  }
  return resp.text();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Auth
  const secret = process.env.SCRAPER_SHARED_SECRET;
  const providedSecret =
    (req.headers["x-api-key"] as string) || (req.query.key as string) || "";
  if (!secret) {
    return res.status(500).json({
      error:
        "Server misconfigured: SCRAPER_SHARED_SECRET env var is not set on Vercel.",
    });
  }
  if (providedSecret !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const input = readInput(req);
  if (!input.country && !input.title && !input.industry && !input.extraTerms) {
    return res.status(400).json({
      error:
        "At least one of country, title, industry, extraTerms is required.",
    });
  }

  const query = buildDorkQuery(input);
  const collected: string[] = [];
  const seenGlobal = new Set<string>();
  const pages: Array<{ page: number; offset: number; newUrls: number }> = [];

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      if (collected.length >= input.limit) break;

      const offset = page * PAGE_SIZE;
      const html = await fetchDDGPage(query, offset);
      const urlsOnPage = extractLinkedInUrls(html);

      let newCount = 0;
      for (const u of urlsOnPage) {
        const key = u.toLowerCase();
        if (seenGlobal.has(key)) continue;
        seenGlobal.add(key);
        collected.push(u);
        newCount++;
        if (collected.length >= input.limit) break;
      }
      pages.push({ page, offset, newUrls: newCount });

      // If this page contributed nothing, DDG is repeating or rate-limiting us. Stop.
      if (newCount === 0) break;

      if (page < MAX_PAGES - 1 && collected.length < input.limit) {
        await sleep(POLITE_DELAY_MS);
      }
    }
  } catch (err: any) {
    return res.status(502).json({
      ok: false,
      error: `DDG fetch failed: ${err.message || String(err)}`,
      query,
      partial: collected.length,
    });
  }

  return res.status(200).json({
    ok: true,
    query,
    input,
    count: collected.length,
    urls: collected.map((url) => ({ url, linkedin: url })),
    debug: { pages },
  });
}
