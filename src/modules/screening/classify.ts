import { config } from "../../config.ts";
import type { ScreeningRule, ScreeningRuleId } from "./rules.ts";

export const TEXT_MODEL = "typesafe/jev-1.13";
export const IMAGE_MODEL = "nvidia/nemotron-3.5-content-safety";

/** Only the new message is judged; the member's earlier lines are context. No display names:
 *  a crude or odd name alone pushed benign messages over the threshold. */
export interface TextState {
  new_message: { text: string };
  earlier_messages_from_same_member?: string[];
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

class RetryableError extends Error {}

async function postOnce(fetchFn: Fetch, path: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new RetryableError(String(err));
  }
  if (!res.ok) {
    const msg = `${path} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
    throw res.status >= 500 || res.status === 429 ? new RetryableError(msg) : new Error(msg);
  }
  return res.json();
}

/** One retry: OpenRouter's /systemone returns sporadic 520s and timeouts that succeed on retry. */
async function postJson(fetchFn: Fetch, path: string, body: unknown): Promise<unknown> {
  try {
    return await postOnce(fetchFn, path, body);
  } catch (err) {
    if (!(err instanceof RetryableError)) throw err;
    return postOnce(fetchFn, path, body);
  }
}

/** One noul per rule about the new message, via OpenRouter's System One endpoint (TypeSafe shape). */
export async function classifyText(state: TextState, rules: readonly ScreeningRule[], fetchFn: Fetch = fetch): Promise<TextVerdict> {
  const questions = Object.fromEntries(
    rules.map((r) => [r.id, { type: "noul", instructions: r.instructions, criteria: r.criteria }]),
  );
  const json = (await postJson(fetchFn, "/systemone", { model: TEXT_MODEL, state, questions })) as {
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

/** Parses Nemotron's output: "User Safety: unsafe", plus "Safety Categories: ..." only when the
 *  template gets `/categories`, which OpenRouter's provider never passes. */
export function parseSafetyOutput(content: string): { unsafe: boolean; categories: string[] } {
  const safety = /User Safety:\s*(safe|unsafe)/i.exec(content)?.[1]?.toLowerCase();
  if (!safety) throw new Error(`unrecognized safety output: ${content.slice(0, 200)}`);
  const cats = /Safety Categories:\s*(.+)/i.exec(content)?.[1];
  const categories = cats ? cats.split(",").map((c) => c.trim()).filter(Boolean) : [];
  return { unsafe: safety === "unsafe", categories };
}

/** The text part is judged together with the image; this wording had the fewest false positives
 *  on benign avatars. A text part is required (image-only requests fail). */
const IMAGE_CAPTION = { pfp: "Profile picture of a Discord user.", image: "Image shared in a Discord chat." } as const;

/** The provider fetches `imageUrl` itself; callers only pass Discord-hosted URLs. */
export async function classifyImage(imageUrl: string, kind: "pfp" | "image", fetchFn: Fetch = fetch): Promise<ImageVerdict> {
  const json = (await postJson(fetchFn, "/chat/completions", {
    model: IMAGE_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: IMAGE_CAPTION[kind] },
        ],
      },
    ],
    max_tokens: 20,
    // Unset, the provider samples and borderline images flip between safe and unsafe.
    temperature: 0,
    // Nemotron reasons by default and burns the token budget before emitting the verdict.
    reasoning: { enabled: false },
    // The :free variant and some providers train on inputs.
    provider: { data_collection: "deny" },
  })) as { model?: string; choices?: { message?: { content?: string | null } }[]; usage?: { cost?: number } };
  const content = json.choices?.[0]?.message?.content ?? "";
  return { ...parseSafetyOutput(content), model: json.model ?? IMAGE_MODEL, cost: json.usage?.cost ?? null };
}
