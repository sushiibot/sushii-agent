// Parity tests: assert the NEW renderDiscordText reproduces the goldens pinned in
// characterization/discordText.characterization.test.ts, without importing the old module.
import { describe, expect, test } from "bun:test";
import { renderDiscordText } from "./render.ts";

const GUILD_ID = "111111111111111111";

describe("renderDiscordText golden parity", () => {
  test("u: token expands to a user mention", () => {
    expect(renderDiscordText("hi u:222222222222222222", GUILD_ID)).toBe("hi <@222222222222222222>");
  });

  test("c: token expands to a channel mention", () => {
    expect(renderDiscordText("see c:333333333333333333", GUILD_ID)).toBe("see <#333333333333333333>");
  });

  test("t: token with explicit flag expands to a Discord timestamp", () => {
    expect(renderDiscordText("t:1700000000:R", GUILD_ID)).toBe("<t:1700000000:R>");
  });

  test("t: token without a flag defaults to :f", () => {
    expect(renderDiscordText("t:1700000000", GUILD_ID)).toBe("<t:1700000000:f>");
  });

  test("t: token accepts other single-letter flags (:D, :t)", () => {
    expect(renderDiscordText("t:1700000000:D", GUILD_ID)).toBe("<t:1700000000:D>");
    expect(renderDiscordText("t:1700000000:t", GUILD_ID)).toBe("<t:1700000000:t>");
  });

  test("e: token expands via emojiMap when the name is known", () => {
    const emojiMap = { pog: "<:pog:444444444444444444>" };
    expect(renderDiscordText("nice e:pog", GUILD_ID, emojiMap)).toBe("nice <:pog:444444444444444444>");
  });

  test("e: token with an unknown name is left as literal text", () => {
    const emojiMap = { pog: "<:pog:444444444444444444>" };
    expect(renderDiscordText("nice e:unknownemoji", GUILD_ID, emojiMap)).toBe("nice e:unknownemoji");
  });

  test("e: token is left as literal text when no emojiMap is passed", () => {
    expect(renderDiscordText("nice e:pog", GUILD_ID)).toBe("nice e:pog");
  });

  test("msg: token expands to a full jump link", () => {
    expect(renderDiscordText("see msg:555555555555555555/666666666666666666", GUILD_ID)).toBe(
      `see https://discord.com/channels/${GUILD_ID}/555555555555555555/666666666666666666`,
    );
  });

  test("plain text passes through unchanged", () => {
    expect(renderDiscordText("just a normal sentence with no tokens.", GUILD_ID)).toBe(
      "just a normal sentence with no tokens.",
    );
  });

  test("combination of token types in one string", () => {
    const emojiMap = { pog: "<:pog:444444444444444444>" };
    const input = "u:222222222222222222 said hi in c:333333333333333333 at t:1700000000:R e:pog see msg:555555555555555555/666666666666666666";
    expect(renderDiscordText(input, GUILD_ID, emojiMap)).toBe(
      "<@222222222222222222> said hi in <#333333333333333333> at <t:1700000000:R> <:pog:444444444444444444> see https://discord.com/channels/111111111111111111/555555555555555555/666666666666666666",
    );
  });

  test("a lone '>' blockquote line is padded so Discord doesn't render it as plain text", () => {
    expect(renderDiscordText("above\n>\nbelow", GUILD_ID)).toBe("above\n> \nbelow");
  });

  test("a single-backtick span containing an expanded token is unwrapped", () => {
    expect(renderDiscordText("`u:222222222222222222 said this`", GUILD_ID)).toBe("<@222222222222222222> said this");
  });

  test("a single-backtick span with no expanded markup stays wrapped (edge case)", () => {
    expect(renderDiscordText("`plain code span`", GUILD_ID)).toBe("`plain code span`");
  });

  test("an unrecognized id-like token that doesn't match token syntax passes through", () => {
    expect(renderDiscordText("x:222222222222222222", GUILD_ID)).toBe("x:222222222222222222");
  });
});
