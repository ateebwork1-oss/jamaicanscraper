import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Caribbean LinkedIn URL discovery endpoint.
 *
 * Input:  { country, title, industry, extraTerms, limit }
 * Output: deduped list of LinkedIn profile URLs.
 *
 * Provider chain (first one that returns URLs wins):
 *   1. Google Custom Search API (needs GOOGLE_API_KEY + GOOGLE_CSE_ID)
 *      -> 100 queries/day free, no CC required, bulletproof from Vercel
 *   2. Bing HTML scrape (no key needed, usually works from datacenter IPs)
 *   3. DuckDuckGo html endpoint (often blocked from Vercel, worth trying)
 *   4. DuckDuckGo Lite endpoint (last resort)
 *
 * Auth: header `x-api-key` OR query `?key=` must equal SCRAPER_SHARED_SECRET.
 */

const MAX_LIMIT = 200;
const DDG_MAX_PAGES = 3;
const DDG_PAGE_SIZE = 50;
const POLITE_DELAY_MS = 600;

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Ch-Ua":
    '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "cross-site",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

interface SearchInput {
  country: string;
  title: string;
  industry: string;
  extraTerms: string;
  limit: number;
}

interface ProviderResult {
  provider: string;
  httpStatus?: number;
  ok: boolean;
  urls: string[];
  error?: string;
  meta?: Record<string, unknown>;
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

function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.search = "";
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if (!u.hostname.endsWith("linkedin.com")) return null;
    if (!u.pathname.startsWith("/in/")) return null;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function extractDirectLinkedInUrls(html: string): string[] {
  const re =
    /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_\-%.]+(?:\/)?/gi;
  const matches = html.match(re) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const norm = normalizeUrl(raw);
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

function extractDDGRedirectedUrls(html: string): string[] {
  const re = /\/l\/\?[^"'>\s]*uddg=([^"'&>\s]+)/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const decoded = decodeURIComponent(m[1]);
      const norm = normalizeUrl(decoded);
      if (!norm) continue;
      const key = norm.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(norm);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function extractBingRedirectedUrls(html: string): string[] {
  // Bing wraps results in /ck/a?!&&p=...&u=a1aHR0cHM... with base64-encoded URLs.
  // BUT it also leaves raw <cite> tags with the real URL visible as text. Easier
  // to just match the direct URLs either in href attributes or cite elements.
  // The extractDirectLinkedInUrls handles these, plus we do a secondary pass on
  // <cite> text.
  const citeRe = /<cite[^>]*>([^<]+)<\/cite>/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = citeRe.exec(html)) !== null) {
    const txt = m[1].replace(/\s/g, "").replace(/\u203a/g, "/"); // strip " › "
    const candidates = extractDirectLinkedInUrls(txt);
    for (const c of candidates) {
      const key = c.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Provider: Google Custom Search API (best if configured) ----------
async function fetchGoogleCSE(
  query: string,
  limit: number,
): Promise<ProviderResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  const cseId = process.env.GOOGLE_CSE_ID;
  if (!apiKey || !cseId) {
    return {
      provider: "google-cse",
      ok: false,
      urls: [],
      error: "GOOGLE_API_KEY and/or GOOGLE_CSE_ID not set",
    };
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  const pagesToFetch = Math.min(Math.ceil(limit / 10), 10); // CSE max 100 results

  try {
    for (let p = 0; p < pagesToFetch; p++) {
      const start = p * 10 + 1;
      const params = new URLSearchParams({
        key: apiKey,
        cx: cseId,
        q: query,
        num: "10",
        start: String(start),
      });
      const resp = await fetch(
        `https://www.googleapis.com/customsearch/v1?${params.toString()}`,
      );
      if (!resp.ok) {
        return {
          provider: "google-cse",
          httpStatus: resp.status,
          ok: urls.length > 0,
          urls,
          error: `google-cse HTTP ${resp.status}`,
        };
      }
      const data: any = await resp.json();
      const items: any[] = data?.items || [];
      if (items.length === 0) break;
      let newCount = 0;
      for (const it of items) {
        const norm = normalizeUrl(String(it?.link || ""));
        if (!norm) continue;
        const key = norm.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(norm);
        newCount++;
      }
      if (newCount === 0) break;
      if (urls.length >= limit) break;
    }
    return {
      provider: "google-cse",
      ok: urls.length > 0,
      urls,
    };
  } catch (err: any) {
    return {
      provider: "google-cse",
      ok: false,
      urls,
      error: err?.message || String(err),
    };
  }
}

// ---------- Provider: Bing HTML scrape ----------
async function fetchBing(
  query: string,
  limit: number,
): Promise<ProviderResult> {
  const urls: string[] = [];
  const seen = new Set<string>();
  let lastStatus: number | undefined;
  const pages = Math.min(Math.ceil(limit / 10), 5);

  try {
    for (let p = 0; p < pages; p++) {
      const first = p * 10 + 1;
      const params = new URLSearchParams({
        q: query,
        first: String(first),
        count: "10",
        setLang: "en-US",
        cc: "US",
      });
      const resp = await fetch(
        `https://www.bing.com/search?${params.toString()}`,
        {
          method: "GET",
          headers: {
            ...BROWSER_HEADERS,
            Referer: "https://www.bing.com/",
          },
        },
      );
      lastStatus = resp.status;
      if (!resp.ok) {
        return {
          provider: "bing",
          httpStatus: resp.status,
          ok: urls.length > 0,
          urls,
          error: `bing HTTP ${resp.status}`,
        };
      }
      const html = await resp.text();
      const direct = extractDirectLinkedInUrls(html);
      const cites = extractBingRedirectedUrls(html);
      const pageUrls = [...direct, ...cites];

      let newCount = 0;
      for (const u of pageUrls) {
        const key = u.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(u);
        newCount++;
      }
      if (newCount === 0) break;
      if (urls.length >= limit) break;
      if (p < pages - 1) await sleep(POLITE_DELAY_MS);
    }
    return {
      provider: "bing",
      httpStatus: lastStatus,
      ok: urls.length > 0,
      urls,
    };
  } catch (err: any) {
    return {
      provider: "bing",
      httpStatus: lastStatus,
      ok: false,
      urls,
      error: err?.message || String(err),
    };
  }
}

// ---------- Provider: DDG html ----------
async function fetchDDGHtml(query: string): Promise<ProviderResult> {
  const urls: string[] = [];
  const seen = new Set<string>();
  let lastStatus: number | undefined;

  try {
    for (let page = 0; page < DDG_MAX_PAGES; page++) {
      const form = new URLSearchParams();
      form.set("q", query);
      form.set("kl", "us-en");
      if (page > 0) form.set("s", String(page * 30));

      const resp = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          Referer: "https://duckduckgo.com/",
          Origin: "https://duckduckgo.com",
        },
        body: form.toString(),
      });
      lastStatus = resp.status;
      if (!resp.ok) {
        return {
          provider: "ddg-html",
          httpStatus: resp.status,
          ok: urls.length > 0,
          urls,
          error: `ddg-html HTTP ${resp.status}`,
        };
      }
      const html = await resp.text();
      const pageUrls = [
        ...extractDirectLinkedInUrls(html),
        ...extractDDGRedirectedUrls(html),
      ];
      let newCount = 0;
      for (const u of pageUrls) {
        const key = u.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(u);
        newCount++;
      }
      if (newCount === 0) break;
      if (page < DDG_MAX_PAGES - 1) await sleep(POLITE_DELAY_MS);
    }
    return {
      provider: "ddg-html",
      httpStatus: lastStatus,
      ok: urls.length > 0,
      urls,
    };
  } catch (err: any) {
    return {
      provider: "ddg-html",
      httpStatus: lastStatus,
      ok: false,
      urls,
      error: err?.message || String(err),
    };
  }
}

// ---------- Provider: DDG lite ----------
async function fetchDDGLite(query: string): Promise<ProviderResult> {
  const urls: string[] = [];
  const seen = new Set<string>();
  let lastStatus: number | undefined;

  try {
    for (let page = 0; page < DDG_MAX_PAGES; page++) {
      const params = new URLSearchParams({ q: query });
      if (page > 0) params.set("s", String(page * DDG_PAGE_SIZE));
      const resp = await fetch(
        `https://lite.duckduckgo.com/lite/?${params.toString()}`,
        {
          method: "GET",
          headers: {
            ...BROWSER_HEADERS,
            Referer: "https://lite.duckduckgo.com/",
          },
        },
      );
      lastStatus = resp.status;
      if (!resp.ok) {
        return {
          provider: "ddg-lite",
          httpStatus: resp.status,
          ok: urls.length > 0,
          urls,
          error: `ddg-lite HTTP ${resp.status}`,
        };
      }
      const html = await resp.text();
      const pageUrls = extractDirectLinkedInUrls(html);
      let newCount = 0;
      for (const u of pageUrls) {
        const key = u.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(u);
        newCount++;
      }
      if (newCount === 0) break;
      if (page < DDG_MAX_PAGES - 1) await sleep(POLITE_DELAY_MS);
    }
    return {
      provider: "ddg-lite",
      httpStatus: lastStatus,
      ok: urls.length > 0,
      urls,
    };
  } catch (err: any) {
    return {
      provider: "ddg-lite",
      httpStatus: lastStatus,
      ok: false,
      urls,
      error: err?.message || String(err),
    };
  }
}

// ---------- Handler ----------
export default async function handler(req: VercelRequest, res: VercelResponse) {
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
  const attempts: ProviderResult[] = [];

  const providers: Array<() => Promise<ProviderResult>> = [
    () => fetchGoogleCSE(query, input.limit),
    () => fetchBing(query, input.limit),
    () => fetchDDGHtml(query),
    () => fetchDDGLite(query),
  ];

  let winner: ProviderResult | null = null;
  for (const run of providers) {
    const result = await run();
    attempts.push(result);
    if (result.ok && result.urls.length > 0) {
      winner = result;
      break;
    }
  }

  if (!winner) {
    return res.status(502).json({
      ok: false,
      query,
      input,
      error:
        "All search providers failed. See debug.attempts[] for per-provider status. The most reliable free option is Google Custom Search API: create a CSE at https://programmablesearchengine.google.com, get an API key at https://console.cloud.google.com (enable 'Custom Search API'), then set GOOGLE_API_KEY and GOOGLE_CSE_ID env vars in Vercel.",
      debug: { attempts },
    });
  }

  const limited = winner.urls.slice(0, input.limit);
  return res.status(200).json({
    ok: true,
    query,
    input,
    provider: winner.provider,
    count: limited.length,
    urls: limited.map((url) => ({ url, linkedin: url })),
    debug: { attempts },
  });
}
