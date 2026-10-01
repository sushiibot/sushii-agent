// Bot preload: login resolves without connecting, so the gateway never opens and ClientReady never fires.
// The path is computed so the harness typecheck does not pull in the bot's whole type graph.
const mod = (await import(new URL("../../src/discordClient.ts", import.meta.url).href)) as { client: { login: () => Promise<string> } };
mod.client.login = async () => {
  console.error("[e2e] discord client.login stubbed; gateway not connected");
  return "stub";
};
export {};
