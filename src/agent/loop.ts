import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Client } from "discord.js";
import { openai } from "./client.ts";
import { config } from "../config.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";
import { runTools } from "./runner.ts";

const SYSTEM_PROMPT = `You are ModAssist, a moderation intelligence assistant for Discord servers. You help moderators investigate user behavior, understand context around incidents, and make informed moderation decisions.

You have access to a 30-day cache of server messages. Use the available tools to search and analyze messages, retrieve user activity profiles, and look up live Discord member information.

Guidelines:
- Be thorough but concise — cite specific evidence (message IDs, timestamps, channels) when making observations
- Be objective and factual; clearly distinguish between confirmed evidence and inference
- Organize your responses clearly with relevant context up front
- All data is strictly scoped to this server only
- Tombstoned (soft-deleted) messages are marked with deleted_at and may still be relevant evidence`;

const MAX_ITERATIONS = 20;

export async function runAgentLoop(
  query: string,
  existingHistory: ChatCompletionMessageParam[],
  guildId: string,
  client: Client<true>,
): Promise<{ response: string; updatedHistory: ChatCompletionMessageParam[] }> {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...existingHistory,
    { role: "user", content: query },
  ];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await openai.chat.completions.create({
      model: config.openaiModel,
      messages,
      tools: TOOL_DEFINITIONS,
      max_tokens: 4096,
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices returned from API");

    messages.push(choice.message);

    if (choice.finish_reason === "stop") {
      const content = choice.message.content ?? "(no response)";
      // Strip system prompt from stored history
      return { response: content, updatedHistory: messages.slice(1) };
    }

    if (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
      const toolResults = await runTools(choice.message.tool_calls, guildId, client);
      messages.push(...toolResults);
      continue;
    }

    // Unexpected finish reason — treat as final response
    const content = choice.message.content ?? "(no response)";
    return { response: content, updatedHistory: messages.slice(1) };
  }

  throw new Error(`Agent loop exceeded ${MAX_ITERATIONS} iterations`);
}
