import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
} from "discord.js";
import { SCREENING_RULES, type ScreeningRuleId } from "./rules.ts";
import type { AutomodSummary, Judged, VerdictRow } from "./store.ts";

export const SCREENING_IGNORE_PREFIX = "scr:ignore:";

const ACTION_THRESHOLD = 0.7;
const BAR_CELLS = 10;
const LINE_MAX = 300;
const ACCENT_OPEN = 0xf0b232;
const ACCENT_ACTIONED = 0xf23f43;

const ANSI_RED = "\u001b[1;31m";
const ANSI_YELLOW = "\u001b[1;33m";
const ANSI_GRAY = "\u001b[0;30m";
const ANSI_RESET = "\u001b[0m";

/** One aligned line per rule on a fixed 10-cell track (filled ━, empty ─) so the full 1.0 length
 *  is visible. Only rules at or over the review threshold get color; Discord's ANSI grey is nearly
 *  invisible on dark themes, so it's reserved for the empty track. Colors are desktop-only. */
export function scoreBars(scores: Partial<Record<ScreeningRuleId, number>>, reviewThreshold: number): string {
  const width = Math.max(...SCREENING_RULES.map((r) => r.id.length)) + 1;
  const lines = SCREENING_RULES.filter((r) => scores[r.id] !== undefined).map((r) => {
    const p = scores[r.id]!;
    const filled = Math.round(p * BAR_CELLS);
    const color = p >= ACTION_THRESHOLD ? ANSI_RED : p >= reviewThreshold ? ANSI_YELLOW : "";
    const label = `${r.id.padEnd(width)}${p.toFixed(2)} `;
    const bar = `${"━".repeat(filled)}`;
    const track = `${ANSI_GRAY}${"─".repeat(BAR_CELLS - filled)}${ANSI_RESET}`;
    return color ? `${color}${label}${bar}${ANSI_RESET}${track}` : `${label}${bar}${track}`;
  });
  return "```ansi\n" + lines.join("\n") + "\n```";
}

export function topRule(scores: Partial<Record<ScreeningRuleId, number>>): ScreeningRuleId | null {
  let best: ScreeningRuleId | null = null;
  for (const r of SCREENING_RULES) {
    const p = scores[r.id];
    if (p !== undefined && (best === null || p > scores[best]!)) best = r.id;
  }
  return best;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat;
}

function titleFor(row: VerdictRow): string {
  if (row.kind === "text") {
    const rule = SCREENING_RULES.find((r) => r.id === row.topRule);
    return `### ⚠️ Suspicious message · likely ${rule?.title ?? "rule violation"}`;
  }
  const cats = parseCategories(row);
  const what = row.kind === "pfp" ? "profile picture" : "image link";
  return `### ⚠️ Suspicious ${what}${cats.length ? ` · ${cats.join(", ").toLowerCase()}` : ""}`;
}

function parseCategories(row: VerdictRow): string[] {
  return row.categories ? (JSON.parse(row.categories) as string[]) : [];
}

function whoLines(row: VerdictRow, automod?: AutomodSummary): string {
  const joined = row.joinedAt ? `joined <t:${Math.floor(row.joinedAt / 1000)}:R> · ` : "";
  const ordinal = row.ordinal ? `message #${row.ordinal} since join · ` : "";
  const deleted = row.messageDeleted ? " · **message deleted**" : "";
  const blocked = automod && automod.count > 0
    ? `\n-# 🛡️ ${automod.count} ${automod.count === 1 ? "message" : "messages"} blocked by AutoMod${automod.rules.length ? ` (${automod.rules.join(", ")})` : ""}`
    : "";
  return `<@${row.userId}> (\`${row.userId}\`)\n-# ${joined}${ordinal}in <#${row.channelId}>${deleted}${blocked}`;
}

function outcomeText(row: VerdictRow): string {
  if (row.outcome === "ignored") return ` · ignored by <@${row.outcomeBy}>`;
  if (row.outcome === "actioned") {
    const by = row.outcomeBy ? ` by <@${row.outcomeBy}>` : "";
    return ` · 🔨 ${row.outcomeAction ?? "actioned"}${by}`;
  }
  return "";
}

/** Verdict reference for the footer and logs, e.g. `scr-1234`: the autoincrement row id, unique
 *  across every guild this bot instance screens. */
export function verdictRef(id: number): string {
  return `scr-${id}`;
}

function footer(row: VerdictRow, ref: string): string {
  const cost = row.cost != null ? ` · $${row.cost.toFixed(5)}` : "";
  const model = (row.model ?? "").replace(/^[^/]+\//, "").replace(/-\d{8}$/, "");
  return `-# ${model}${cost} · \`${ref}\`${outcomeText(row)}`;
}

/** Rebuilt from the stored row on every edit (ignore, mod action, delete), so the post never
 *  depends on the original message still existing. */
export function buildVerdictPost(
  row: VerdictRow,
  reviewThreshold: number,
  extras: { automod?: AutomodSummary } = {},
): ContainerBuilder {
  const { automod } = extras;
  const ref = verdictRef(row.id);
  const container = new ContainerBuilder();
  if (row.outcome === "actioned") container.setAccentColor(ACCENT_ACTIONED);
  else if (row.outcome !== "ignored") container.setAccentColor(ACCENT_OPEN);

  const header = `${titleFor(row)}\n${whoLines(row, automod)}`;

  if (row.kind === "pfp" && row.sourceUrl) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder({ content: header }))
        .setThumbnailAccessory(new ThumbnailBuilder().setURL(row.sourceUrl).setSpoiler(true)),
    );
  } else {
    container.addTextDisplayComponents(new TextDisplayBuilder({ content: header }));
  }

  if (row.kind === "text") {
    const judged = row.judged ? (JSON.parse(row.judged) as Judged) : { context: [], target: [] };
    const lines = [
      ...judged.context.map((l) => `-# ${l.author}: ${oneLine(l.text)}`),
      ...judged.target.map((l) => `> **${l.author}:** ${oneLine(l.text)}`),
    ];
    container.addSeparatorComponents(new SeparatorBuilder());
    container.addTextDisplayComponents(new TextDisplayBuilder({ content: lines.join("\n") || "-# (no text)" }));
    container.addSeparatorComponents(new SeparatorBuilder());
    const scores = row.scores ? (JSON.parse(row.scores) as Partial<Record<ScreeningRuleId, number>>) : {};
    container.addTextDisplayComponents(new TextDisplayBuilder({ content: `${scoreBars(scores, reviewThreshold)}\n${footer(row, ref)}` }));
  } else {
    if (row.kind === "image" && row.sourceUrl) {
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(row.sourceUrl).setSpoiler(true)),
      );
    }
    const verdict = "```ansi\n" + `${ANSI_RED}unsafe${parseCategories(row).length ? ` · ${parseCategories(row).join(", ")}` : ""}${ANSI_RESET}` + "\n```";
    const source = row.kind === "image" && row.sourceUrl ? `-# ${new URL(row.sourceUrl).hostname}${new URL(row.sourceUrl).pathname}\n` : "";
    container.addTextDisplayComponents(new TextDisplayBuilder({ content: `${source}${verdict}\n${footer(row, ref)}` }));
  }

  const jump = new ButtonBuilder()
    .setStyle(ButtonStyle.Link)
    .setLabel("Jump to message")
    .setURL(`https://discord.com/channels/${row.guildId}/${row.channelId}/${row.messageId}`);
  const buttons: ButtonBuilder[] = [];
  if (row.outcome === null) {
    buttons.push(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Ignore").setCustomId(`${SCREENING_IGNORE_PREFIX}${row.id}`));
  }
  buttons.push(jump);
  container.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
  return container;
}
