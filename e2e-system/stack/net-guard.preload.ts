// Bot and workspace preload. Answers the OpenRouter model catalog locally (the URL is hard-coded in
// piShared.ts, and without `image` in input_modalities the workspace drops photo parts) and refuses
// every other non-loopback fetch. discord.js REST goes through undici directly, so it is not covered.
const model = process.env["E2E_MODEL_ID"] ?? "openai/gpt-e2e";
const realFetch = globalThis.fetch;

function urlOf(input: string | URL | Request): URL | undefined {
  try {
    return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  } catch {
    return undefined;
  }
}

const isLoopback = (host: string) => /^127\./.test(host) || host === "localhost" || host === "[::1]";

// With E2E_PUSH_CAPTURE set (the bot), a Web Push POST is written there and answered 201, so a flow can
// decrypt what the bot sent with the subscription keys it registered.
const pushCapture = process.env["E2E_PUSH_CAPTURE"];
const PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);

async function capturePush(url: URL, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const body = Buffer.from(await req.arrayBuffer()).toString("base64");
  const headers = Object.fromEntries([...req.headers].filter(([k]) => k !== "authorization"));
  const { appendFileSync } = await import("node:fs");
  appendFileSync(pushCapture!, `${JSON.stringify({ endpoint: url.href, headers, body })}\n`);
  return new Response(null, { status: 201 });
}

const guarded = (input: string | URL | Request, init?: RequestInit) => {
  const url = urlOf(input);
  if (!url || url.protocol === "file:" || url.protocol === "data:" || url.protocol === "blob:" || isLoopback(url.hostname)) {
    return realFetch(input, init);
  }
  if (url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/models") {
    const entry = { id: model, context_length: 400000, architecture: { input_modalities: ["text", "image"] }, top_provider: { max_completion_tokens: 32000 } };
    return Promise.resolve(Response.json({ data: [entry] }));
  }
  if (pushCapture && url.protocol === "https:" && PUSH_HOSTS.has(url.hostname)) return capturePush(url, input, init);
  console.error(`[e2e-net] blocked fetch ${url.origin}${url.pathname}`);
  return Promise.reject(new TypeError(`e2e: network disabled for ${url.origin}`));
};
globalThis.fetch = Object.assign(guarded, { preconnect: realFetch.preconnect }) as typeof fetch;
export {};
