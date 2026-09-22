import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getLogger } from "../../../logger.ts";
import type { McpToolCall } from "./mnemosyneMemoryProvider.ts";

const logger = getLogger("core/memory/mnemosyne/client");

export interface MnemosyneClientConfig {
  url: string;
  token?: string | undefined;
}

function extractPayload(content: unknown): unknown {
  if (!Array.isArray(content)) {
    throw new Error("Unexpected mnemosyne MCP response: content is not an array");
  }
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("Unexpected mnemosyne MCP response: no text content");
  }
  return JSON.parse(first.text);
}

/**
 * Real MCP call seam for the mnemosyne provider: a lazily-connected, reused streamable-HTTP client.
 * The connection is established on first use and kept; any failure drops it so the next call
 * reconnects. Returns the parsed JSON tool payload the provider expects.
 */
export function createMnemosyneCallTool(cfg: MnemosyneClientConfig): McpToolCall {
  let clientPromise: Promise<Client> | null = null;

  async function connect(): Promise<Client> {
    const client = new Client({ name: "sushii-agent", version: "1.0.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: cfg.token
        ? { headers: { Authorization: `Bearer ${cfg.token}` } }
        : undefined,
    });
    await client.connect(transport);
    return client;
  }

  function ensureConnected(): Promise<Client> {
    if (clientPromise === null) {
      clientPromise = connect().catch((err) => {
        clientPromise = null; // don't cache a failed connect
        throw err;
      });
    }
    return clientPromise;
  }

  function reset(): void {
    const pending = clientPromise;
    clientPromise = null;
    void pending?.then((c) => c.close()).catch(() => {});
  }

  return async (name, args, signal) => {
    const client = await ensureConnected();
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal });
      return extractPayload(result.content);
    } catch (err) {
      // Reconnect on the next call — a broken stream shouldn't poison every subsequent request.
      logger.debug({ err, tool: name }, "mnemosyne MCP call failed; resetting connection");
      reset();
      throw err;
    }
  };
}
