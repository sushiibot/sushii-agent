// OpenAI-compatible chat-completions stand-in for OpenRouter. Replies are scripted by keywords in the
// last user message (see the README). A `#<tag>` in that message makes every reply start with
// `re-<tag>`, so a flow can find its own reply. GET /__log returns every request it has seen.
import { stackConfig } from "./config.ts";

const { ports, addrs, model } = stackConfig();
const enc = new TextEncoder();
const seen: LlmRequest[] = [];
let n = 0;

// A flow holds a stream at a known chunk until it has exercised the concurrent operation.
const held = new Map<string, () => void>();

export interface LlmRequest {
  n: number;
  at: string;
  lastRole?: string;
  userText: string;
  images: number;
  lastImages: number;
  tools: string[];
  lastTool?: string;
}

type Part = { type?: string; text?: string };
type Msg = { role?: string; content?: unknown };

const chunk = (delta: object, finish: string | null, extra: object = {}) =>
  `data: ${JSON.stringify({ id: `gen-${n}`, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
const usage = { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as Part[]).map((p) => (p?.type === "text" ? (p.text ?? "") : "")).join("\n");
  return "";
}

const imagesIn = (content: unknown) => (Array.isArray(content) ? (content as Part[]).filter((p) => p?.type === "image_url").length : 0);

function stream(pieces: string[], gapMs: number, tag: string | undefined, delayMs = 0, reasoning = false, holdAfter?: number): Response {
  if (tag) pieces = [`re-${tag} ${pieces[0] ?? ""}`, ...pieces.slice(1)];
  let cancelled = false;
  let release: (() => void) | undefined;
  const gate = holdAfter === undefined ? undefined : new Promise<void>((resolve) => { release = resolve; });
  if (gate && tag) held.set(tag, release!);
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
      release?.();
      if (tag) held.delete(tag);
    },
    async start(c) {
      try {
        await Bun.sleep(delayMs);
        if (reasoning) {
          c.enqueue(enc.encode(chunk({ role: "assistant", reasoning_content: "Private reasoning must never appear in chat." }, null)));
          await Bun.sleep(3000);
        }
        for (const [i, p] of pieces.entries()) {
          if (i === holdAfter) await gate;
          if (cancelled) return;
          c.enqueue(enc.encode(chunk({ role: "assistant", content: p }, null)));
          await Bun.sleep(gapMs);
        }
        if (cancelled) return;
        c.enqueue(enc.encode(chunk({}, "stop", usage)));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      } finally {
        if (tag) held.delete(tag);
      }
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function toolCall(name: string, args: object): Response {
  const call = { index: 0, id: `call_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
  const body = chunk({ role: "assistant", tool_calls: [call] }, null) + chunk({}, "tool_calls", usage) + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function reply(msgs: Msg[], userText: string, lastUser: Msg | undefined): Response {
  const last = msgs[msgs.length - 1];
  const tag = /#([a-z0-9]{4,16})\b/.exec(userText)?.[1];
  if (last?.role === "tool") return stream([`Tool finished. Result: ${textOf(last.content).slice(0, 160).replace(/\n/g, " ")}`], 50, tag);
  // 400 is outside Pi's retryable errors, so the run fails at once.
  if (userText.includes("E2E-JOBFAIL")) return Response.json({ error: { message: "E2E-JOBFAIL scripted failure", code: 400 } }, { status: 400 });
  if (userText.includes("E2E-NOREPLY")) return stream(["NO_REPLY"], 10, undefined);
  if (userText.includes("E2E-APPROVE")) {
    const title = `E2E approval ${tag ?? "test"}`;
    return toolCall("file_linear_issue", { repo_label: "sushii-agent", title, description: "Filed by the e2e fake model." });
  }
  if (userText.includes("E2E-PHOTO")) {
    const total = msgs.reduce((a, m) => a + imagesIn(m.content), 0);
    return stream([`I received ${imagesIn(lastUser?.content)} image part(s) in this turn `, `(${total} in the whole context).`], 100, tag);
  }
  if (userText.includes("E2E-THINK")) return stream(["Thoughtful reply."], 100, tag, 3000, true);
  if (userText.includes("E2E-WAIT")) return stream(["Reply without reasoning."], 100, tag, 3500);
  if (userText.includes("E2E-SLOW")) {
    const controlled = userText.includes("E2E-HOLD");
    return stream(Array.from({ length: 30 }, (_, i) => `slow${i} `), controlled ? 25 : 500, tag, 0, false, controlled ? 4 : undefined);
  }
  const echo = /E2E-ECHO (\S+)/.exec(userText);
  if (echo) return stream([`Echo ${echo[1]}.`], 10, tag, userText.includes("E2E-LATE") ? 4000 : 0, false, userText.includes("E2E-HOLD") ? 0 : undefined);
  const fill = /E2E-FILL-(\d+)/.exec(userText);
  if (fill) return stream([`Filler reply ${fill[1]}.`], 10, tag);
  return stream(["**Bold reply** with a list:\n\n", "- one\n- two\n\n", "```ts\nconst answer = 42;\nconsole.log(answer);\n```\n\n", "Done."], 400, tag);
}

Bun.serve({
  port: ports.llm,
  hostname: addrs.local,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/__release") {
      const tag = url.searchParams.get("tag") ?? "";
      const release = held.get(tag);
      if (!release) return new Response("no held stream for tag", { status: 404 });
      release();
      held.delete(tag);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__log") return Response.json(seen);
    if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: model, context_length: 400000 }] });
    if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
    n++;
    const body = (await req.json()) as { messages?: Msg[]; tools?: { function?: { name?: string } }[] };
    const msgs = body.messages ?? [];
    const last = msgs[msgs.length - 1];
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const userText = textOf(lastUser?.content);
    seen.push({
      n,
      at: new Date().toISOString(),
      lastRole: last?.role,
      userText: userText.slice(0, 600),
      images: msgs.reduce((a, m) => a + imagesIn(m.content), 0),
      lastImages: imagesIn(lastUser?.content),
      tools: (body.tools ?? []).map((t) => t.function?.name ?? ""),
      lastTool: last?.role === "tool" ? textOf(last.content).slice(0, 400) : undefined,
    });
    return reply(msgs, userText, lastUser);
  },
});
console.log(`fake llm on ${addrs.local}:${ports.llm}`);
