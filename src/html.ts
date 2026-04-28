let cheerioPromise: Promise<typeof import("cheerio")> | undefined;

async function getCheerio() {
  if (cheerioPromise == null) {
    cheerioPromise = import("cheerio");
  }
  return await cheerioPromise;
}

export async function extractPreviewLink(html: string): Promise<string | null> {
  const cheerio = await getCheerio();
  const $ = cheerio.load(html);
  return $("a[href]:not([rel=tag]):not(.mention):last").attr("href") ?? null;
}

export async function extractText(html: string | null): Promise<string | null> {
  if (html == null) return null;
  const cheerio = await getCheerio();
  const $ = cheerio.load(html);
  return $(":root").text();
}
