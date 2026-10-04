import { expect, test } from "bun:test";
import { createVoiceAgent } from "./agent.ts";
import { mintWebActor } from "../actor.ts";
import type { WebThreads } from "../threadRoutes.ts";

test("voice uses a valid durable chat ID and waits for the matching agent reply", async () => {
  let listener: (reply: any) => void = () => {};
  let unsubscribed = false;
  const actor = mintWebActor("owner@example.com");
  const threads = {
    channel: (conversation: string) => {
      expect(conversation).toBe("topic");
      return {
        adapter: {
          openTurns: () => [],
          subscribeReply: (next: typeof listener) => {
            listener = next;
            return () => {
              unsubscribed = true;
            };
          },
        },
        routes: {
          handle: async (
            req: Request,
            path: string,
            receivedActor: unknown,
          ) => {
            expect(path).toBe("/api/chat/messages");
            expect(receivedActor).toBe(actor);
            const body = await req.json();
            expect(body.clientId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
            expect(body.text).toBe("check my calendar");
            listener({ kind: "reply", replyTo: "other", text: "unrelated" });
            listener({
              kind: "reply",
              replyTo: body.clientId,
              text: "Your calendar is clear.",
            });
            return new Response(null, { status: 202 });
          },
        },
      };
    },
  } as unknown as WebThreads;
  expect(
    await createVoiceAgent(threads)(
      "check my calendar",
      actor,
      "topic",
      new AbortController().signal,
    ),
  ).toBe("Your calendar is clear.");
  expect(unsubscribed).toBe(true);
});
