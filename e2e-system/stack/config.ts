// Every port and loopback address the stack uses. Shared by the runner (bun) and the flows (node),
// so it must not import bun:* modules.

function int(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number, got ${raw}`);
  return n;
}

function addr(name: string, fallback: string): string {
  const raw = process.env[name]?.trim() || fallback;
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(raw)) throw new Error(`${name} must be a 127.0.0.0/8 address, got ${raw}`);
  return raw;
}

export function stackConfig() {
  const base = int("E2E_PORT_BASE", 4500);
  return {
    ports: {
      proxy: int("E2E_PROXY_PORT", base),
      web: int("E2E_WEB_PORT", base + 1),
      llm: int("E2E_LLM_PORT", base + 2),
      mcp: int("E2E_MCP_PORT", base + 3),
      orch: int("E2E_ORCH_PORT", base + 4),
      control: int("E2E_CONTROL_PORT", base + 5),
    },
    addrs: {
      // The fake model, the control server, and the bot's orchestration and MCP ports as dialed.
      local: addr("E2E_LOCAL_ADDR", "127.0.0.1"),
      // Where the browser reaches the proxy. Not "localhost": GitHub's runners resolve it to ::1 first.
      proxy: addr("E2E_PROXY_ADDR", "127.0.0.1"),
      bot: addr("E2E_BOT_ADDR", "127.0.0.2"),
      trustedPeer: addr("E2E_PEER_ADDR", "127.0.0.3"),
      untrusted: addr("E2E_UNTRUSTED_ADDR", "127.0.0.5"),
    },
    ownerLogin: process.env["E2E_OWNER_LOGIN"]?.trim() || "owner@e2e",
    model: "openai/gpt-e2e",
  };
}

export type StackConfig = ReturnType<typeof stackConfig>;
