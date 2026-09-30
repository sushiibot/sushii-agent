// OpenAI-compatible chat-completions stand-in for OpenRouter. Replies are scripted by keywords in the
// last user message; see SCRIPT in the README. GET /__log returns every request it has seen.
import { stackConfig } from "./config.ts";

const { ports, model } = stackConfig();
const enc = new TextEncoder();
const seen: LlmRequest[] = [];
let n = 0;

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

function stream(pieces: string[], gapMs: number): Response {
  const body = new ReadableStream({
    async start(c) {
      for (const p of pieces) {
        c.enqueue(enc.encode(chunk({ role: "assistant", content: p }, null)));
        await Bun.sleep(gapMs);
      }
      c.enqueue(enc.encode(chunk({}, "stop", usage)));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
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
  if (last?.role === "tool") return stream([`Tool finished. Result: ${textOf(last.content).slice(0, 160).replace(/\n/g, " ")}`], 50);
  if (userText.includes("E2E-APPROVE")) {
    return toolCall("file_linear_issue", { repo_label: "sushii-agent", title: "E2E approval test", description: "Filed by the e2e fake model." });
  }
  if (userText.includes("E2E-PHOTO")) {
    const total = msgs.reduce((a, m) => a + imagesIn(m.content), 0);
    return stream([`I received ${imagesIn(lastUser?.content)} image part(s) in this turn `, `(${total} in the whole context).`], 100);
  }
  if (userText.includes("E2E-SLOW")) return stream(Array.from({ length: 30 }, (_, i) => `slow${i} `), 500);
  const echo = /E2E-ECHO (\S+)/.exec(userText);
  if (echo) return stream([`Echo ${echo[1]}.`], 10);
  const fill = /E2E-FILL-(\d+)/.exec(userText);
  if (fill) return stream([`Filler reply ${fill[1]}.`], 10);
  return stream(["**Bold reply** with a list:\n\n", "- one\n- two\n\n", "```ts\nconst answer = 42;\nconsole.log(answer);\n```\n\n", "Done."], 400);
}

Bun.serve({
  port: ports.llm,
  hostname: "127.0.0.1",
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
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
console.log(`fake llm on 127.0.0.1:${ports.llm}`);
