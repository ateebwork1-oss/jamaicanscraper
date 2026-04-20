import moment from "moment-timezone";

export interface Location {
  city: string | null;
  province: string | null;
  country: string | null;
}

export const formatDate = (date: string | null): string | null => {
  if (!date) return null;
  if (date === "Present") return moment().format();
  const parsed = moment(date, ["MMM YYYY", "MMMY", "YYYY"]);
  return parsed.isValid() ? parsed.format() : null;
};

export const getDurationInDays = (
  formattedStartDate: string | null,
  formattedEndDate: Date | string | null,
): number | null => {
  if (!formattedStartDate || !formattedEndDate) return null;
  return moment(formattedEndDate).diff(moment(formattedStartDate), "days") + 1;
};

export const getLocationFromText = (text: string | null): Location | null => {
  if (!text) return null;
  const cleanText = text.replace(" Area", "").trim();
  const parts = cleanText.split(", ").map((p) => p.trim()).filter(Boolean);

  if (parts.length === 3) {
    return { city: parts[0], province: parts[1], country: parts[2] };
  }
  if (parts.length === 2) {
    return { city: parts[0], province: null, country: parts[1] };
  }
  if (parts.length === 1) {
    return { city: null, province: null, country: parts[0] };
  }
  return null;
};

export const getCleanText = (text: string | null | undefined): string | null => {
  if (!text) return null;
  return text
    .replace(/(\r\n\t|\n|\r\t)/gm, "")
    .replace(/ +/g, " ")
    .replace("...", "")
    .replace("See more", "")
    .replace("See less", "")
    .trim();
};

export const statusLog = (section: string, message: string, sid?: string | number) => {
  const s = sid ? ` (${sid})` : "";
  console.log(`Scraper (${section})${s}: ${message}`);
};

export const getHostname = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

export const autoScroll = async (page: any) => {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  });
};
