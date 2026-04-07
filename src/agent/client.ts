import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../config.ts";

const _openaiProvider = createOpenAI({
  apiKey: config.openaiApiKey,
  baseURL: config.openaiBaseUrl,
});

// Use .chat() explicitly — @ai-sdk/openai v3 defaults to Responses API,
// but OpenRouter only supports Chat Completions.
export const openaiProvider = (model: string) => _openaiProvider.chat(model);
