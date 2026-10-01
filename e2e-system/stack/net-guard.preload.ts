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

const guarded = (input: string | URL | Request, init?: RequestInit) => {
  const url = urlOf(input);
  if (!url || url.protocol === "file:" || url.protocol === "data:" || url.protocol === "blob:" || isLoopback(url.hostname)) {
    return realFetch(input, init);
  }
  if (url.origin === "https://openrouter.ai" && url.pathname === "/api/v1/models") {
    const entry = { id: model, context_length: 400000, architecture: { input_modalities: ["text", "image"] }, top_provider: { max_completion_tokens: 32000 } };
    return Promise.resolve(Response.json({ data: [entry] }));
  }
  console.error(`[e2e-net] blocked fetch ${url.origin}${url.pathname}`);
  return Promise.reject(new TypeError(`e2e: network disabled for ${url.origin}`));
};
globalThis.fetch = Object.assign(guarded, { preconnect: realFetch.preconnect }) as typeof fetch;
export {};
