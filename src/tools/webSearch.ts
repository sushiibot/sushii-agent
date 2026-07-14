import Exa from "exa-js";
import { config } from "../config.ts";

let client: Exa | null | undefined;

function getClient(): Exa | null {
  if (client === undefined) {
    client = config.exaApiKey ? new Exa(config.exaApiKey) : null;
  }
  return client;
}

const ALLOWED_SEARCH_TYPES = ["auto", "instant", "fast"] as const;
type SearchType = (typeof ALLOWED_SEARCH_TYPES)[number];

interface WebSearchArgs {
  query: string;
  num_results?: number;
  search_type?: SearchType;
}

export interface WebSearchResultItem {
  title: string | null;
  url: string;
  publishedDate: string | null;
  highlights: string[];
}

export async function webSearch(args: WebSearchArgs): Promise<WebSearchResultItem[] | { error: string }> {
  const exa = getClient();
  if (!exa) return { error: "Web search is not configured (missing EXA_API_KEY)" };

  const numResults = Math.min(Math.max(args.num_results ?? 5, 1), 10);
  const type = ALLOWED_SEARCH_TYPES.includes(args.search_type as SearchType) ? args.search_type! : "auto";

  try {
    const res = await exa.search(args.query, {
      type,
      numResults,
      contents: { highlights: true },
    });

    return res.results.map((r) => ({
      title: r.title ?? null,
      url: r.url,
      publishedDate: r.publishedDate ?? null,
      highlights: r.highlights ?? [],
    }));
  } catch (err) {
    return { error: `Web search failed: ${err}` };
  }
}

interface FetchUrlContentArgs {
  url: string;
}

export interface UrlContentResult {
  title: string | null;
  url: string;
  publishedDate: string | null;
  text: string;
  truncated: boolean;
}

const MAX_CONTENT_CHARS = 8000;

function isFetchableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function fetchUrlContent(args: FetchUrlContentArgs): Promise<UrlContentResult | { error: string }> {
  const exa = getClient();
  if (!exa) return { error: "Web search is not configured (missing EXA_API_KEY)" };
  if (!isFetchableUrl(args.url)) return { error: `Invalid URL: ${args.url} — must be an http or https URL` };

  try {
    const res = await exa.getContents([args.url], { text: { maxCharacters: MAX_CONTENT_CHARS } });
    const r = res.results[0];
    if (!r) return { error: `No content found for ${args.url}` };

    const text = r.text ?? "";
    return {
      title: r.title ?? null,
      url: r.url,
      publishedDate: r.publishedDate ?? null,
      text,
      truncated: text.length >= MAX_CONTENT_CHARS,
    };
  } catch (err) {
    return { error: `Fetching URL content failed: ${err}` };
  }
}
