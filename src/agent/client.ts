import { createOpenAI } from "@ai-sdk/openai";
import { config } from "../config.ts";

export const openaiProvider = createOpenAI({
  apiKey: config.openaiApiKey,
  baseURL: config.openaiBaseUrl,
  compatibility: "compatible",
});
