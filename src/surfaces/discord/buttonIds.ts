// Discord button customId prefixes. Byte-identical to the pre-cutover constants in
// agent/delivery.ts and modules/moderation/interactions.ts — Discord component
// interactions are matched by exact customId prefix, so these can't drift.

export const STOP_BTN_PREFIX = "stop:";
export const ASK_BTN_PREFIX = "agq:";
export const FEEDBACK_BTN_PREFIX = "fb:";
export const FEEDBACK_MODAL_PREFIX = "fbm:";
export const SCAN_BTN_PREFIX = "srv:";
export const AUTOMOD_BTN_PREFIX = "amka:";
export const AUTOMOD_DEL_BTN_PREFIX = "amkd:";
