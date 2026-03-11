import type { ChatCompletionMessageParam, ChatCompletionMessageToolCall } from "openai/resources/chat/completions";
import type { Client } from "discord.js";
import { searchMessages } from "../tools/searchMessages.ts";
import { getConversationContext } from "../tools/getConversationContext.ts";
import { getUserProfile } from "../tools/getUserProfile.ts";
import { getRecentActivity } from "../tools/getRecentActivity.ts";
import { getCurrentMemberInfo } from "../tools/getCurrentMemberInfo.ts";

export async function runTools(
  toolCalls: ChatCompletionMessageToolCall[],
  guildId: string,
  client: Client<true>,
): Promise<ChatCompletionMessageParam[]> {
  const results = await Promise.all(
    toolCalls.map(async (call) => {
      let result: unknown;

      try {
        const args = JSON.parse(call.function.arguments) as Record<string, unknown>;

        switch (call.function.name) {
          case "search_messages":
            result = searchMessages({ ...args, guildId } as Parameters<typeof searchMessages>[0]);
            break;
          case "get_conversation_context":
            result = getConversationContext({
              ...args,
              guildId,
            } as Parameters<typeof getConversationContext>[0]);
            break;
          case "get_user_profile":
            result = getUserProfile({ ...args, guildId } as Parameters<typeof getUserProfile>[0]);
            break;
          case "get_recent_activity":
            result = getRecentActivity({
              ...args,
              guildId,
            } as Parameters<typeof getRecentActivity>[0]);
            break;
          case "get_current_member_info":
            result = await getCurrentMemberInfo({
              ...args,
              guildId,
              client,
            } as Parameters<typeof getCurrentMemberInfo>[0]);
            break;
          default:
            result = { error: `Unknown tool: ${call.function.name}` };
        }
      } catch (err) {
        result = { error: String(err) };
      }

      return {
        role: "tool" as const,
        tool_call_id: call.id,
        content: JSON.stringify(result),
      };
    }),
  );

  return results;
}
