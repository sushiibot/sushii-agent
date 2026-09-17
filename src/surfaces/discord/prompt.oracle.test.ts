import { describe, expect, test } from "bun:test";
// TEMPORARY (U4-cutover phase 3 deletes this file with src/agent/loop.ts). Proves the ported core
// assembleSystemPrompt stays byte-identical to the old buildSystemPrompt while both exist, so the
// committed golden in prompt.parity.test.ts is a faithful capture of production behavior.
import { buildSystemPrompt, type AgentLoopOptions } from "../../agent/loop.ts";
import { assembleSystemPrompt, type SystemPromptInputs } from "../../core/systemPrompt.ts";
import { PROMPT_CASES } from "./__fixtures__/systemPromptCases.ts";

function toLegacy(i: SystemPromptInputs): AgentLoopOptions {
  return {
    botId: i.selfId,
    botUsername: i.selfName,
    currentChannel: i.channel
      ? {
          id: i.channel.id,
          name: i.channel.name,
          type: i.channel.type,
          isPrivate: i.channel.isPrivate,
          topic: i.channel.topic ?? undefined,
          categoryName: i.channel.categoryName ?? undefined,
          parentChannelId: i.channel.parentChannelId ?? undefined,
          parentChannelName: i.channel.parentChannelName ?? undefined,
        }
      : undefined,
    triggeringUser: i.author
      ? { id: i.author.userId, username: i.author.username ?? "", displayName: i.author.displayName ?? null, roles: i.author.roles ?? [], isModerator: i.author.isModerator ?? false }
      : undefined,
    serverContext: i.serverContext,
    memoryIndex: i.memoryIndex,
    memoryCount: i.memoryCount,
    memoryLimit: i.memoryLimit,
    emojiMap: i.emojiMap,
    threadContext: i.threadContext,
    currentChannelId: i.threadChannelId,
    extraPromptSections: i.moduleExtras,
  };
}

describe("assembleSystemPrompt matches legacy buildSystemPrompt", () => {
  for (const [name, inputs] of Object.entries(PROMPT_CASES)) {
    test(name, () => {
      expect(assembleSystemPrompt(inputs)).toBe(buildSystemPrompt(inputs.behavior, toLegacy(inputs)));
    });
  }
});
