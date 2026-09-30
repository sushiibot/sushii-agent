import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { resolveModelInfo } from "./piShared.ts";

const catalog = {
  data: [
    { id: "vendor/text-only", context_length: 128_000, architecture: { input_modalities: ["text"] } },
    { id: "vendor/vision", context_length: 200_000, architecture: { input_modalities: ["text", "image"] } },
    { id: "vendor/bare", context_length: 64_000 },
  ],
};

let spy: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  spy?.mockRestore();
  spy = null;
});

function serve(response: () => Promise<Response>) {
  spy = spyOn(globalThis, "fetch").mockImplementation((() => response()) as unknown as typeof fetch);
}

describe("resolveModelInfo", () => {
  test("image input is declared only when the catalog lists it", async () => {
    serve(async () => Response.json(catalog));
    expect(await resolveModelInfo("vendor/text-only", 1)).toEqual({ contextWindow: 128_000, image: false });
    expect(await resolveModelInfo("vendor/vision", 1)).toEqual({ contextWindow: 200_000, image: true });
    expect(await resolveModelInfo("vendor/bare", 1)).toEqual({ contextWindow: 64_000, image: false });
  });

  test("an unknown model, an HTTP error or a network failure falls back to text-only and the given window", async () => {
    serve(async () => Response.json(catalog));
    expect(await resolveModelInfo("vendor/missing", 42)).toEqual({ contextWindow: 42, image: false });
    spy!.mockRestore();
    serve(async () => new Response("down", { status: 503 }));
    expect(await resolveModelInfo("vendor/vision", 42)).toEqual({ contextWindow: 42, image: false });
    spy!.mockRestore();
    serve(async () => Promise.reject(new Error("offline")));
    expect(await resolveModelInfo("vendor/vision", 42)).toEqual({ contextWindow: 42, image: false });
  });
});
