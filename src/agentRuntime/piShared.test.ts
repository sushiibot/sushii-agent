import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearOpenRouterCatalog, openRouterCatalog, resolveModelInfo } from "./piShared.ts";

const catalog = {
  data: [
    { id: "vendor/text-only", context_length: 128_000, architecture: { input_modalities: ["text"] } },
    { id: "vendor/vision", context_length: 200_000, architecture: { input_modalities: ["text", "image"] } },
    { id: "vendor/bare", context_length: 64_000 },
  ],
};

let spy: ReturnType<typeof spyOn> | null = null;
// The catalog is cached per process, and other test files may have filled it (or remembered a failure).
beforeEach(() => clearOpenRouterCatalog());
afterEach(() => {
  spy?.mockRestore();
  spy = null;
  clearOpenRouterCatalog();
});

function serve(response: () => Promise<Response>) {
  spy = spyOn(globalThis, "fetch").mockImplementation((() => response()) as unknown as typeof fetch);
}

describe("resolveModelInfo", () => {
  test("image input is declared only when the catalog lists it", async () => {
    serve(async () => Response.json(catalog));
    expect(await resolveModelInfo("vendor/text-only", 1)).toMatchObject({ contextWindow: 128_000, image: false });
    expect(await resolveModelInfo("vendor/vision", 1)).toMatchObject({ contextWindow: 200_000, image: true });
    expect(await resolveModelInfo("vendor/bare", 1)).toMatchObject({ contextWindow: 64_000, image: false });
  });

  test("an unknown model, an HTTP error or a network failure falls back to text-only and the given window", async () => {
    serve(async () => Response.json(catalog));
    expect(await resolveModelInfo("vendor/missing", 42)).toMatchObject({ contextWindow: 42, image: false });
    spy!.mockRestore();
    clearOpenRouterCatalog();
    serve(async () => new Response("down", { status: 503 }));
    expect(await resolveModelInfo("vendor/vision", 42)).toMatchObject({ contextWindow: 42, image: false });
    spy!.mockRestore();
    clearOpenRouterCatalog();
    serve(async () => Promise.reject(new Error("offline")));
    expect(await resolveModelInfo("vendor/vision", 42)).toMatchObject({ contextWindow: 42, image: false });
  });
});

describe("openRouterCatalog", () => {
  test("reads tools support and per-million prices, and is fetched once per ten minutes", async () => {
    let calls = 0;
    serve(async () => {
      calls++;
      return Response.json({
        data: [
          { id: "vendor/agent", name: "Agent", context_length: 1_000_000, supported_parameters: ["tools", "temperature"], pricing: { prompt: "0.00000021", completion: "0.00000042" } },
          { id: "vendor/chat", context_length: 8_000, pricing: { prompt: "x" } },
          { id: "vendor/broken" },
        ],
      });
    });
    const t = Date.parse("2026-10-01T00:00:00Z");
    const models = await openRouterCatalog(t);
    expect(models).toEqual([
      { id: "vendor/agent", name: "Agent", contextWindow: 1_000_000, image: false, tools: true, priceIn: 0.21, priceOut: 0.42 },
      { id: "vendor/chat", name: "vendor/chat", contextWindow: 8_000, image: false, tools: false, priceIn: null, priceOut: null },
    ]);
    await openRouterCatalog(t + 9 * 60_000);
    expect(calls).toBe(1);
    await openRouterCatalog(t + 11 * 60_000);
    expect(calls).toBe(2);
  });
});
