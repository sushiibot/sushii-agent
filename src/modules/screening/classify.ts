import { config } from "../../config.ts";
import type { ScreeningRule, ScreeningRuleId } from "./rules.ts";

export const TEXT_MODEL = "typesafe/jev-1.13";
export const IMAGE_MODEL = "nvidia/nemotron-3.5-content-safety";

export interface StateMessage {
  id: string;
  author: string;
  target: boolean;
  text: string;
}

export interface TextVerdict {
  scores: Partial<Record<ScreeningRuleId, number>>;
  model: string;
  cost: number | null;
}

export interface ImageVerdict {
  unsafe: boolean;
  categories: string[];
  model: string;
  cost: number | null;
}

type Fetch = typeof fetch;

function baseUrl(): string {
  return config.openaiBaseUrl.replace(/\/$/, "");
}

async function postJson(fetchFn: Fetch, path: string, body: unknown): Promise<unknown> {
  const res = await fetchFn(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  return res.json();
}

/** One noul per rule over the channel window, via OpenRouter's System One endpoint (TypeSafe shape). */
export async function classifyText(
  messages: StateMessage[],
  rules: readonly ScreeningRule[],
  fetchFn: Fetch = fetch,
): Promise<TextVerdict> {
  const questions = Object.fromEntries(rules.map((r) => [r.id, { type: "noul", instructions: r.instructions }]));
  const json = (await postJson(fetchFn, "/systemone", { model: TEXT_MODEL, state: { messages }, questions })) as {
    model?: string;
    answers?: Record<string, { noul?: number }>;
    usage?: { cost?: number };
  };
  const scores: Partial<Record<ScreeningRuleId, number>> = {};
  for (const r of rules) {
    const p = json.answers?.[r.id]?.noul;
    if (typeof p !== "number") throw new Error(`systemone response missing answer for ${r.id}`);
    scores[r.id] = p;
  }
  return { scores, model: json.model ?? TEXT_MODEL, cost: json.usage?.cost ?? null };
}

/** Parses Nemotron's standard-mode output: "User Safety: unsafe\nSafety Categories: Sexual, ...". */
export function parseSafetyOutput(content: string): { unsafe: boolean; categories: string[] } {
  const safety = /User Safety:\s*(safe|unsafe)/i.exec(content)?.[1]?.toLowerCase();
  if (!safety) throw new Error(`unrecognized safety output: ${content.slice(0, 200)}`);
  const cats = /Safety Categories:\s*(.+)/i.exec(content)?.[1];
  const categories = cats ? cats.split(",").map((c) => c.trim()).filter(Boolean) : [];
  return { unsafe: safety === "unsafe", categories };
}

/** The provider fetches `imageUrl` itself; callers only pass Discord-hosted URLs. */
export async function classifyImage(imageUrl: string, fetchFn: Fetch = fetch): Promise<ImageVerdict> {
  const json = (await postJson(fetchFn, "/chat/completions", {
    model: IMAGE_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: "Image posted in a Discord server." },
        ],
      },
    ],
    max_tokens: 60,
    // Nemotron reasons by default and burns the token budget before emitting the verdict.
    reasoning: { enabled: false },
    // The :free variant and some providers train on inputs.
    provider: { data_collection: "deny" },
  })) as { model?: string; choices?: { message?: { content?: string | null } }[]; usage?: { cost?: number } };
  const content = json.choices?.[0]?.message?.content ?? "";
  return { ...parseSafetyOutput(content), model: json.model ?? IMAGE_MODEL, cost: json.usage?.cost ?? null };
}
