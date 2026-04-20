import type { VercelRequest, VercelResponse } from "@vercel/node";
import { scrapeLinkedInProfile } from "../lib/scraper";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Simple shared-secret auth to prevent the world from calling your endpoint.
  const secret = process.env.SCRAPER_SHARED_SECRET;
  const providedSecret =
    (req.headers["x-api-key"] as string) ||
    (req.query.key as string) ||
    "";

  if (!secret) {
    return res.status(500).json({
      error:
        "Server misconfigured: SCRAPER_SHARED_SECRET env var is not set on Vercel.",
    });
  }
  if (providedSecret !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Accept url either as query (?url=...) or JSON body { url: "..." }
  const url =
    (req.query.url as string) ||
    (req.body && (req.body as any).url) ||
    "";

  if (!url) {
    return res.status(400).json({
      error:
        "Missing 'url'. Pass ?url=https://www.linkedin.com/in/handle/ or JSON body { url: ... }.",
    });
  }

  // Allow overriding the li_at cookie per-request (handy for rotating accounts).
  // Falls back to the env var set on Vercel.
  const sessionCookieValue =
    (req.headers["x-linkedin-cookie"] as string) ||
    (req.body && (req.body as any).sessionCookieValue) ||
    process.env.LINKEDIN_SESSION_COOKIE_VALUE ||
    "";

  if (!sessionCookieValue) {
    return res.status(500).json({
      error:
        "No LinkedIn session cookie configured. Set LINKEDIN_SESSION_COOKIE_VALUE in Vercel env vars.",
    });
  }

  try {
    const result = await scrapeLinkedInProfile({
      profileUrl: url,
      sessionCookieValue,
    });
    return res.status(200).json({ ok: true, data: result });
  } catch (err: any) {
    const message = err?.message || String(err);
    const status = err?.name === "SessionExpired" ? 401 : 500;
    return res.status(status).json({
      ok: false,
      error: message,
      name: err?.name || "Error",
    });
  }
}
