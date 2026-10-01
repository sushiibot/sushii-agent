import { describe, expect, test } from "bun:test";
import type { TranscribableAudio } from "../../agent/transcribe.ts";
import { DICTATION_MAX_BYTES, createDictationRoutes } from "./dictationRoutes.ts";

function setup(result: string | null = "hello there") {
  const calls: TranscribableAudio[] = [];
  const routes = createDictationRoutes({ transcribe: async (a) => (calls.push(a), result) });
  const post = (body: BodyInit | null, type = "audio/webm;codecs=opus", method = "POST") =>
    routes.handle(new Request("http://x/api/dictation", { method, body, headers: { "Content-Type": type } }), "/api/dictation");
  return { routes, calls, post };
}

describe("POST /api/dictation", () => {
  test("transcribes the recorded audio under a file name the endpoint understands", async () => {
    const h = setup();
    const res = (await h.post(new Uint8Array([1, 2, 3])))!;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello there" });
    expect(h.calls.map((c) => [c.mediaType, c.filename, c.data.byteLength])).toEqual([["audio/webm", "dictation.webm", 3]]);
    await h.post(new Uint8Array([1]), "audio/mp4");
    expect(h.calls[1]!.filename).toBe("dictation.m4a");
  });

  test("no words is a 422; bad types, empty and oversized bodies never reach the transcriber", async () => {
    expect((await setup(null).post(new Uint8Array([1])))!.status).toBe(422);
    const h = setup();
    expect((await h.post(new Uint8Array([1]), "text/plain"))!.status).toBe(415);
    expect((await h.post(new Uint8Array([]), "audio/ogg"))!.status).toBe(400);
    expect((await h.post(new Uint8Array(DICTATION_MAX_BYTES + 1)))!.status).toBe(413);
    expect((await h.routes.handle(new Request("http://x/api/dictation"), "/api/dictation"))!.status).toBe(405);
    expect(await h.routes.handle(new Request("http://x/api/other"), "/api/other")).toBeNull();
    expect(h.calls).toEqual([]);
  });
});
