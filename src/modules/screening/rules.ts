// Leaf module (no imports): teams.ts validates against these ids while config.ts is still loading.

export const SCREENING_RULE_IDS = ["scam", "spam", "nsfw", "hate", "harassment", "troll"] as const;
export type ScreeningRuleId = (typeof SCREENING_RULE_IDS)[number];

export interface ScreeningRule {
  id: ScreeningRuleId;
  /** Shown in the post title: "Suspicious message · likely <title>". */
  title: string;
  /** Jev noul question about the target author's messages in `state`. Jev reads literally, so each
   *  question names concrete examples rather than an abstract category. */
  instructions: string;
}

export const SCREENING_RULES: readonly ScreeningRule[] = [
  {
    id: "scam",
    title: "scam",
    instructions:
      "Do the messages marked target:true try to scam or phish people, e.g. fake free Nitro, crypto or giveaways, 'DM me' offers, or suspicious claim/login links?",
  },
  {
    id: "spam",
    title: "spam",
    instructions:
      "Do the messages marked target:true advertise or spam, e.g. server invites, self-promotion, or the same message repeated?",
  },
  {
    id: "nsfw",
    title: "NSFW",
    instructions: "Do the messages marked target:true contain sexual or explicit content, or link to it?",
  },
  {
    id: "hate",
    title: "hate speech",
    instructions:
      "Do the messages marked target:true use slurs or attack people for their race, ethnicity, religion, gender, sexuality, or disability?",
  },
  {
    id: "harassment",
    title: "harassment",
    instructions: "Do the messages marked target:true insult, threaten, or harass a specific person?",
  },
  {
    id: "troll",
    title: "trolling",
    instructions:
      "Do the messages marked target:true deliberately bait, derail, or provoke others to get a reaction?",
  },
];
