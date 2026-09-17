// Wiki search/read tools — host-gated on `wiki`, which the surface provides only for spaces whose
// wiki-sync module is enabled. Lets a conversational turn ground answers in the synced knowledge base.
import type { ToolEntry } from "../../contracts.ts";
import "../hosts.ts";

export const searchWikiEntry: ToolEntry<"wiki"> = {
  name: "search_wiki",
  definition: {
    name: "search_wiki",
    description:
      "Search this server's wiki — a knowledge base sushii continuously builds from channel activity (people, topics, decisions, history). Returns the best-matching pages with a snippet and a link. Prefer this for background and prior context before falling back to live message lookups; cite the returned link when you use a page.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms (names, topics, keywords)." },
        limit: { type: "number", description: "Max pages to return (default 5)." },
      },
      required: ["query"],
    },
  },
  requiresHosts: ["wiki"],
  async execute(input, ctx) {
    const query = input.query as string;
    const hits = await ctx.wiki.search(query, input.limit as number | undefined);
    if (hits.length === 0) return { content: `No wiki pages matched "${query}".` };
    return {
      content: hits
        .map((h) => `## ${h.title}${h.url ? `\n${h.url}` : ""}\npath: ${h.path}\n${h.snippet}`)
        .join("\n\n"),
    };
  },
};

export const readWikiPageEntry: ToolEntry<"wiki"> = {
  name: "read_wiki_page",
  definition: {
    name: "read_wiki_page",
    description: "Read the full markdown of a wiki page by its repo-relative path (as returned by search_wiki).",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative page path, e.g. people/alice.md." } },
      required: ["path"],
    },
  },
  requiresHosts: ["wiki"],
  async execute(input, ctx) {
    const path = input.path as string;
    const page = await ctx.wiki.read(path);
    if (!page) return { content: `Wiki page not found: ${path}` };
    return { content: page.url ? `${page.url}\n\n${page.content}` : page.content };
  },
};

export const WIKI_TOOL_ENTRIES: ToolEntry<"wiki">[] = [searchWikiEntry, readWikiPageEntry];
