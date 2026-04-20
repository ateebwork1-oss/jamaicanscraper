import chromium from "@sparticuz/chromium";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { SessionExpired } from "./errors";
import {
  autoScroll,
  formatDate,
  getCleanText,
  getDurationInDays,
  getLocationFromText,
  Location,
  statusLog,
} from "./utils";

export interface Profile {
  fullName: string | null;
  title: string | null;
  location: Location | null;
  photo: string | null;
  description: string | null;
  url: string;
}

export interface Experience {
  title: string | null;
  company: string | null;
  employmentType: string | null;
  location: Location | null;
  startDate: string | null;
  endDate: string | null;
  endDateIsPresent: boolean;
  durationInDays: number | null;
  description: string | null;
}

export interface Education {
  schoolName: string | null;
  degreeName: string | null;
  fieldOfStudy: string | null;
  startDate: string | null;
  endDate: string | null;
  durationInDays: number | null;
}

export interface Skill {
  skillName: string | null;
  endorsementCount: number | null;
}

export interface ScrapeResult {
  userProfile: Profile;
  experiences: Experience[];
  education: Education[];
  skills: Skill[];
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const NAVIGATION_TIMEOUT = 45000;

interface RunOptions {
  profileUrl: string;
  sessionCookieValue: string;
}

/**
 * One-shot scrape for a single LinkedIn profile URL. Launches Chromium,
 * authenticates via li_at cookie, scrapes, then closes the browser.
 *
 * Designed for serverless (Vercel) — no keepAlive, no shared browser.
 */
export async function scrapeLinkedInProfile(
  opts: RunOptions,
): Promise<ScrapeResult> {
  const { profileUrl, sessionCookieValue } = opts;

  if (!profileUrl || !/^https?:\/\/.*linkedin\.com\//.test(profileUrl)) {
    throw new Error("Invalid LinkedIn profile URL.");
  }
  if (!sessionCookieValue) {
    throw new Error("Missing sessionCookieValue (li_at).");
  }

  let browser: Browser | null = null;

  try {
    const executablePath = await chromium.executablePath();
    statusLog("setup", `Launching Chromium at ${executablePath}`);

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        "--hide-scrollbars",
        "--disable-web-security",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      defaultViewport: { width: 1200, height: 720 },
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_USER_AGENT);

    // Block heavy/irrelevant resources to speed up + reduce memory
    const blockedResources = [
      "image",
      "media",
      "font",
      "texttrack",
      "object",
      "beacon",
      "csp_report",
      "imageset",
    ];
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (blockedResources.includes(req.resourceType())) return req.abort();
      return req.continue();
    });

    await page.setCookie({
      name: "li_at",
      value: sessionCookieValue,
      domain: ".www.linkedin.com",
    });

    // 1. Confirm session still valid
    await page.goto("https://www.linkedin.com/feed", {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });
    const currentUrl = page.url();
    if (/\/login|\/checkpoint|\/authwall/.test(currentUrl)) {
      throw new SessionExpired(
        "LinkedIn session expired or challenged. Refresh your li_at cookie.",
      );
    }

    // 2. Go to the profile
    statusLog("run", `Navigating to ${profileUrl}`);
    await page.goto(profileUrl, {
      waitUntil: "networkidle2",
      timeout: NAVIGATION_TIMEOUT,
    });

    await autoScroll(page);

    // 3. Click "see more" expanders (best-effort; selectors drift frequently)
    const expandButtonSelectors = [
      "button.inline-show-more-text__button",
      "button.pv-profile-section__see-more-inline",
      ".pv-profile-section.pv-about-section .lt-line-clamp__more",
      "#experience-section .pv-profile-section__see-more-inline.link",
    ];
    for (const sel of expandButtonSelectors) {
      try {
        const buttons = await page.$$(sel);
        for (const b of buttons) {
          try {
            await b.click({ delay: 20 });
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
    }

    await new Promise((r) => setTimeout(r, 500));

    // 4. Extract top-card profile data.
    //    NOTE: these selectors are best-effort and will likely need maintenance
    //    as LinkedIn changes its DOM. Expect null fields when DOM drifts.
    const rawProfile = await page.evaluate(() => {
      const getText = (sel: string): string | null => {
        const el = document.querySelector(sel) as HTMLElement | null;
        return el?.innerText || el?.textContent || null;
      };

      const fullName =
        getText("h1") ||
        getText(".pv-top-card--list li:first-child") ||
        getText(".text-heading-xlarge");

      const title =
        getText(".text-body-medium.break-words") ||
        getText(".pv-top-card h2") ||
        getText(".pv-top-card .text-body-medium");

      const location =
        getText(".pv-top-card .text-body-small.inline") ||
        getText(
          ".pv-top-card--list.pv-top-card--list-bullet.mt1 li:first-child",
        );

      const photoEl =
        (document.querySelector(
          ".pv-top-card__photo img",
        ) as HTMLImageElement) ||
        (document.querySelector(
          ".profile-photo-edit__preview",
        ) as HTMLImageElement) ||
        (document.querySelector(
          "img.pv-top-card-profile-picture__image",
        ) as HTMLImageElement);
      const photo = photoEl?.src || null;

      const description =
        getText("#about ~ div .inline-show-more-text") ||
        getText(".pv-about__summary-text .lt-line-clamp__raw-line");

      return {
        fullName,
        title,
        location,
        photo,
        description,
        url: window.location.href,
      };
    });

    const userProfile: Profile = {
      fullName: getCleanText(rawProfile.fullName),
      title: getCleanText(rawProfile.title),
      location: getLocationFromText(rawProfile.location),
      photo: rawProfile.photo,
      description: getCleanText(rawProfile.description),
      url: rawProfile.url,
    };

    // 5. Experiences — multi-selector fallback
    const rawExperiences = await page.evaluate(() => {
      const selectors = [
        "#experience-section ul > li",
        "section[data-section='experience'] li",
        "section#experience ~ * li",
        "div#experience ~ div li.artdeco-list__item",
      ];
      let nodes: Element[] = [];
      for (const sel of selectors) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length) {
          nodes = found;
          break;
        }
      }
      return nodes.map((node) => {
        const q = (sel: string) =>
          (node.querySelector(sel) as HTMLElement | null)?.innerText ||
          (node.querySelector(sel) as HTMLElement | null)?.textContent ||
          null;
        return {
          title: q("h3") || q(".t-bold span[aria-hidden='true']") || q(".mr1.t-bold"),
          company:
            q(".pv-entity__secondary-title") ||
            q(".t-14.t-normal span[aria-hidden='true']"),
          employmentType: q("span.pv-entity__secondary-title"),
          location:
            q(".pv-entity__location span:nth-child(2)") ||
            q(".t-14.t-normal.t-black--light span[aria-hidden='true']"),
          description: q(".pv-entity__description") || q(".inline-show-more-text"),
          dateRange:
            q(".pv-entity__date-range span:nth-child(2)") ||
            q(".t-14.t-normal.t-black--light:nth-of-type(2) span[aria-hidden='true']"),
        };
      });
    });

    const experiences: Experience[] = rawExperiences.map((raw: any) => {
      const [startPart, endPart] = (raw.dateRange || "").split(/[–-]/).map(
        (s: string) => s?.trim() || null,
      );
      const endDateIsPresent =
        (endPart || "").toLowerCase() === "present" || false;
      const startDate = formatDate(startPart);
      const endDate = endDateIsPresent ? formatDate("Present") : formatDate(endPart);
      const durationInDays = getDurationInDays(startDate, endDate);
      return {
        title: getCleanText(raw.title),
        company: getCleanText(raw.company),
        employmentType: getCleanText(raw.employmentType),
        location: getLocationFromText(raw.location),
        startDate,
        endDate,
        endDateIsPresent,
        durationInDays,
        description: getCleanText(raw.description),
      };
    });

    // 6. Education
    const rawEducation = await page.evaluate(() => {
      const selectors = [
        "#education-section ul > li",
        "section[data-section='education'] li",
        "div#education ~ div li.artdeco-list__item",
      ];
      let nodes: Element[] = [];
      for (const sel of selectors) {
        const found = Array.from(document.querySelectorAll(sel));
        if (found.length) {
          nodes = found;
          break;
        }
      }
      return nodes.map((node) => {
        const q = (sel: string) =>
          (node.querySelector(sel) as HTMLElement | null)?.innerText ||
          (node.querySelector(sel) as HTMLElement | null)?.textContent ||
          null;
        return {
          schoolName:
            q("h3.pv-entity__school-name") ||
            q(".t-bold span[aria-hidden='true']"),
          degreeName:
            q(".pv-entity__degree-name .pv-entity__comma-item") ||
            q(".t-14.t-normal span[aria-hidden='true']"),
          fieldOfStudy: q(".pv-entity__fos .pv-entity__comma-item"),
          dateRange:
            q(".pv-entity__dates time") ||
            q(".t-14.t-normal.t-black--light span[aria-hidden='true']"),
        };
      });
    });

    const education: Education[] = rawEducation.map((raw: any) => {
      const [startPart, endPart] = (raw.dateRange || "").split(/[–-]/).map(
        (s: string) => s?.trim() || null,
      );
      const startDate = formatDate(startPart);
      const endDate = formatDate(endPart);
      return {
        schoolName: getCleanText(raw.schoolName),
        degreeName: getCleanText(raw.degreeName),
        fieldOfStudy: getCleanText(raw.fieldOfStudy),
        startDate,
        endDate,
        durationInDays: getDurationInDays(startDate, endDate),
      };
    });

    // 7. Skills
    const skills: Skill[] = await page.evaluate(() => {
      const nodes = Array.from(
        document.querySelectorAll(
          ".pv-skill-categories-section ol > li, section[data-section='skills'] li",
        ),
      );
      return nodes.map((node) => {
        const name =
          (node.querySelector(
            ".pv-skill-category-entity__name-text",
          ) as HTMLElement | null)?.textContent?.trim() ||
          (node.querySelector(
            ".t-bold span[aria-hidden='true']",
          ) as HTMLElement | null)?.textContent?.trim() ||
          null;
        const endEl =
          (node.querySelector(
            ".pv-skill-category-entity__endorsement-count",
          ) as HTMLElement | null)?.textContent?.trim() || "0";
        return { skillName: name, endorsementCount: parseInt(endEl || "0", 10) || 0 };
      });
    });

    return {
      userProfile,
      experiences,
      education,
      skills,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
