import type { WebThreads } from "../threadRoutes.ts";
import type { AskAgent } from "./session.ts";
import { ulid } from "../../../workspace/ulid.ts";
/** Uses the same durable input routes, actor and approval flow as typed web chat. */
export function createVoiceAgent(threads: WebThreads): AskAgent {
  return async (text, actor, conversation, signal) => {
    const channel = threads.channel(conversation);
    if (signal.aborted) throw new Error("Voice call ended");
    if (channel.adapter.openTurns().length)
      return "Sushii is already working. Wait for the current turn or use the web chat to steer it.";
    const clientId = ulid();
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout>;
    let rejectReply: (reason: Error) => void = () => {};
    const abort = () => rejectReply(new Error("Voice call ended"));
    const reply = new Promise<string>((resolve, reject) => {
      rejectReply = reject;
      unsubscribe = channel.adapter.subscribeReply((reply) => {
        if (reply.kind === "reply" && reply.replyTo === clientId)
          resolve(reply.text);
      });
      timer = setTimeout(
        () =>
          resolve(
            "Sushii is still working or waiting for your approval. Check the web chat; no completion has been confirmed yet.",
          ),
        15 * 60 * 1000,
      );
      signal.addEventListener("abort", abort, { once: true });
    });
    // Attach a handler before the POST awaits: cancellation can arrive during routing.
    void reply.catch(() => {});
    try {
      const res = await channel.routes.handle(
        new Request("http://voice.internal/api/chat/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId, text }),
        }),
        "/api/chat/messages",
        actor,
      );
      if (!res?.ok) throw new Error("Sushii couldn't accept the voice request");
      return await reply;
    } finally {
      unsubscribe();
      clearTimeout(timer!);
      signal.removeEventListener("abort", abort);
    }
  };
}
