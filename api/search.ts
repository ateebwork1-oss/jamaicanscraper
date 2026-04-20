import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Caribbean LinkedIn URL discovery endpoint.
 *
 * Input:  { country, title, industry, extraTerms, limit }
 * Output: deduped list of LinkedIn profile URLs.
 *
 * Provider chain (first one that returns URLs wins):
 *   1. DuckDuckGo HTML endpoint (POST html.duckduckgo.com/html/)
 *   2. DuckDuckGo Lite endpoint (GET lite.duckduckgo.com/lite/)
 *   3. Brave Search API           (only if BRAVE_API_KEY env var is set)
 *
 * DDG frequently 403s datacenter IPs. Brave is the reliable fallback;
 * it has a free 2,000-query/month tier at https://brave.com/search/api/.
 *
 * Auth: header `x-api-key` OR query `?key=` must equal SCRAPER_SHARED_SECRET.
 */

const MAX_LIMIT = 200;
const MAX_PAGES = 4;
const PAGE_SIZE = 50;
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

/**
 * DDG html endpoint wraps result URLs in a redirect like
 *   //duckduckgo.com/l/?uddg=ENCODED_REAL_URL&...
 * Extract and decode those.
 */
function extractDDGRedirectedUrls(html: string): string[] {
  const re = /\/l\/\?[^"'>\s]*uddg=([^"'&>\s]+)/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const encoded = m[1];
    try {
      const decoded = decodeURIComponent(encoded);
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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDDGHtml(query: string): Promise<ProviderResult> {
  const urls: string[] = [];
  const seen = new Set<string>();
  let lastStatus: number | undefined;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
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
          ok: false,
          urls,
          error: `ddg-html HTTP ${resp.status}`,
        };
      }
      const html = await resp.text();
      const direct = extractDirectLinkedInUrls(html);
      const redirected = extractDDGRedirectedUrls(html);
      const pageUrls = [...direct, ...redirected];

      let newCount = 0;
      for (const u of pageUrls) {
        const key = u.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(u);
        newCount++;
      }
      if (newCount === 0) break;
      if (page < MAX_PAGES - 1) await sleep(POLITE_DELAY_MS);
    }
    return { provider: "ddg-html", httpStatus: lastStatus, ok: urls.length > 0, urls };
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

async function fetchDDGLite(query: string): Promise<ProviderResult> {
  const urls: string[] = [];
  const seen = new Set<string>();
  let lastStatus: number | undefined;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ q: query });
      if (page > 0) params.set("s", String(page * PAGE_SIZE));
      const resp = await fetch(
        `https://lite.duckduckgo.com/lite/?${params.toString()}`,
        {
          method: "GET",
          headers: { ...BROWSER_HEADERS, Referer: "https://lite.duckduckgo.com/" },
        },
      );
      lastStatus = resp.status;
      if (!resp.ok) {
        return {
          provider: "ddg-lite",
          httpStatus: resp.status,
          ok: false,
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
      if (page < MAX_PAGES - 1) await sleep(POLITE_DELAY_MS);
    }
    return { provider: "ddg-lite", httpStatus: lastStatus, ok: urls.length > 0, urls };
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

async function fetchBrave(query: string): Promise<ProviderResult> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) {
    return {
      provider: "brave",
      ok: false,
      urls: [],
      error: "BRAVE_API_KEY not set",
    };
  }
  const urls: string[] = [];
  const seen = new Set<string>();
  try {
    // Brave API: up to 20 results per request; paginate via `offset` (0-9)
    for (let page = 0; page < 3; page++) {
      const params = new URLSearchParams({
        q: query,
        count: "20",
        offset: String(page),
        result_filter: "web",
      });
      const resp = await fetch(
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        {
          method: "GET",
          headers: {
            "X-Subscription-Token": apiKey,
            Accept: "application/json",
            "Accept-Encoding": "gzip",
          },
        },
      );
      if (!resp.ok) {
        return {
          provider: "brave",
          httpStatus: resp.status,
          ok: urls.length > 0,
          urls,
          error: `brave HTTP ${resp.status}`,
        };
      }
      const data: any = await resp.json();
      const results = (data?.web?.results as any[]) || [];
      let newCount = 0;
      for (const r of results) {
        const norm = normalizeUrl(String(r?.url || ""));
        if (!norm) continue;
        const key = norm.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push(norm);
        newCount++;
      }
      if (newCount === 0) break;
      // Brave free tier: 1 req/sec
      await sleep(1100);
    }
    return { provider: "brave", ok: urls.length > 0, urls };
  } catch (err: any) {
    return {
      provider: "brave",
      ok: false,
      urls,
      error: err?.message || String(err),
    };
  }
}

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

  // Provider chain: DDG html → DDG lite → Brave
  const providers: Array<() => Promise<ProviderResult>> = [
    () => fetchDDGHtml(query),
    () => fetchDDGLite(query),
    () => fetchBrave(query),
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
        "All providers failed to return LinkedIn URLs. See debug.attempts for per-provider status. If DDG keeps returning 403, set BRAVE_API_KEY in Vercel env vars (free tier: https://brave.com/search/api/).",
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
