import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { config } from "../config.ts";
import { secrets } from "../secrets.ts";

const _openrouterProvider = createOpenRouter({
  apiKey: secrets.OPENAI_API_KEY,
});

export const openaiProvider = (model: string) => _openrouterProvider(model);
