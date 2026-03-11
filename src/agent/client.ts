import OpenAI from "openai";
import { config } from "../config.ts";

export const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  baseURL: config.openaiBaseUrl,
});
