import { config } from "../../config.ts";
import type { ScreeningRule, ScreeningRuleId } from "./rules.ts";

export const TEXT_MODEL = "typesafe/jev-1.13";
export const IMAGE_MODEL = "google/gemini-3.5-flash-lite";

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
  reason: string;
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

export const IMAGE_CATEGORIES = ["ok", "sexual", "minor_sexual", "gore", "hate", "scam"] as const;
export type ImageCategory = (typeof IMAGE_CATEGORIES)[number];

/** An explicit allow list, not a guard model's taxonomy: those count profanity, weapons and
 *  copyrighted characters as unsafe, which flags ordinary avatars. */
const IMAGE_POLICY = `You review an image posted on Discord for the server's moderators. Flag it only if it clearly shows one of:
- sexual: nudity (exposed genitals, female nipples, bare buttocks), including in paintings, drawings and classical art; sex acts, pornographic or fetish imagery
- minor_sexual: any sexualized depiction of a minor, real or drawn
- gore: real or realistic graphic violence, mutilation, dead bodies, self-harm injuries
- hate: hate symbols (swastika, SS runes, KKK, etc.) or imagery demeaning a protected group
- scam: fake giveaways, free Nitro/crypto offers, QR codes or links urging people to claim something
Everything else is fine, including: selfies and photos of real people or celebrities, swimwear, revealing outfits without nudity, shirtless people, cartoons, anime, game art, logos, text, memes, crude gestures, weapons, alcohol, tobacco, drugs, skulls, dark or edgy art.
When unsure, answer "ok".`;

const IMAGE_SCHEMA = {
  name: "image_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["category", "reason"],
    properties: {
      category: { type: "string", enum: IMAGE_CATEGORIES },
      reason: { type: "string", description: "One short sentence describing what the image shows." },
    },
  },
};

const IMAGE_CAPTION = { pfp: "Profile picture of a Discord user.", image: "Image shared in a Discord chat." } as const;

export function parseImageReview(content: string): { unsafe: boolean; categories: string[]; reason: string } {
  let parsed: { category?: unknown; reason?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`unrecognized image review: ${content.slice(0, 200)}`);
  }
  const category = parsed.category as ImageCategory;
  if (!IMAGE_CATEGORIES.includes(category)) throw new Error(`unrecognized image category: ${String(parsed.category)}`);
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  return { unsafe: category !== "ok", categories: category === "ok" ? [] : [category], reason };
}

/** The provider fetches `imageUrl` itself; callers only pass Discord-hosted URLs. */
export async function classifyImage(imageUrl: string, kind: "pfp" | "image", fetchFn: Fetch = fetch): Promise<ImageVerdict> {
  const json = (await postJson(fetchFn, "/chat/completions", {
    model: IMAGE_MODEL,
    messages: [
      { role: "system", content: IMAGE_POLICY },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: IMAGE_CAPTION[kind] },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: IMAGE_SCHEMA },
    // Gemini 3 loops on repeated tokens below its default temperature, so none is set.
    max_tokens: 2000,
    reasoning: { effort: "low" },
    // Some providers train on inputs.
    provider: { data_collection: "deny" },
  })) as {
    model?: string;
    choices?: { finish_reason?: string | null; native_finish_reason?: string | null; message?: { content?: string | null } }[];
    usage?: { cost?: number };
  };
  const choice = json.choices?.[0];
  const meta = { model: json.model ?? IMAGE_MODEL, cost: json.usage?.cost ?? null };
  // Provider-side filters block the worst images outright; those must surface as flags, not errors.
  if (choice?.finish_reason === "content_filter" || /SAFETY|PROHIBITED|BLOCKLIST|SPII/i.test(choice?.native_finish_reason ?? "")) {
    return { unsafe: true, categories: ["blocked"], reason: `Provider refused to review it (${choice?.native_finish_reason ?? choice?.finish_reason}).`, ...meta };
  }
  return { ...parseImageReview(choice?.message?.content ?? ""), ...meta };
}
