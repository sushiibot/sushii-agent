import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "../config.ts";

const _openrouterProvider = createOpenRouter({
  apiKey: config.openaiApiKey,
});

export const openaiProvider = (model: string) => _openrouterProvider(model);
