import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getLogger } from "../../../logger.ts";
import type { McpToolCall } from "./mnemosyneMemoryProvider.ts";

const logger = getLogger("core/memory/mnemosyne/client");

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** The low-level connection the factory manages. The default binds a real SSE MCP client (mnemosyne
 *  serves the `sse` transport); tests supply a fake to exercise connect/abort/reset without a live server. */
export interface MnemosyneClient {
  connect(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface MnemosyneClientConfig {
  url: string;
  token?: string | undefined;
  /** Rejects a hung (black-holed) connect so a wedged provider can retry. */
  connectTimeoutMs?: number;
  /** Test seam: build the underlying client. Defaults to a real SSE MCP client. */
  createClient?: (cfg: MnemosyneClientConfig) => MnemosyneClient;
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

function defaultCreateClient(cfg: MnemosyneClientConfig): MnemosyneClient {
  const client = new Client({ name: "sushii-agent", version: "1.0.0" }, { capabilities: {} });
  const transport = new SSEClientTransport(new URL(cfg.url), {
    requestInit: cfg.token
      ? { headers: { Authorization: `Bearer ${cfg.token}` } }
      : undefined,
  });
  return {
    connect: () => client.connect(transport),
    callTool: async (name, args, signal) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal });
      return extractPayload(result.content);
    },
    close: () => client.close(),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  return (err as { name?: string } | null)?.name === "AbortError" || signal?.aborted === true;
}

/**
 * Real MCP call seam for the mnemosyne provider: a lazily-connected, reused client. The connection
 * is established on first use and kept; a genuine transport/stream failure drops it so the next call
 * reconnects, while a caller abort (deadline race, or a concurrent slow call from the other surface)
 * leaves the healthy connection intact. Returns the parsed JSON tool payload the provider expects.
 */
export function createMnemosyneCallTool(cfg: MnemosyneClientConfig): McpToolCall {
  const createClient = cfg.createClient ?? defaultCreateClient;
  const connectTimeoutMs = cfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  let clientPromise: Promise<MnemosyneClient> | null = null;

  async function connect(): Promise<MnemosyneClient> {
    const client = createClient(cfg);
    try {
      await withTimeout(client.connect(), connectTimeoutMs, "mnemosyne connect timed out");
    } catch (err) {
      // A timeout may leave a half-open connection whose connect later succeeds — close it so a
      // wedged start doesn't leak a socket on every slow connect.
      void client.close().catch(() => {});
      throw err;
    }
    return client;
  }

  function ensureConnected(): Promise<MnemosyneClient> {
    if (clientPromise === null) {
      clientPromise = connect().catch((err) => {
        clientPromise = null; // don't cache a failed connect — a later call retries
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
      return await client.callTool(name, args, signal);
    } catch (err) {
      if (isAbortError(err, signal)) {
        // A deadline/abort isn't a transport failure — keep the (healthy-but-slow) connection so a
        // concurrent surface isn't forced through a re-handshake on every slow turn.
        throw err;
      }
      // Reconnect on the next call — a broken stream shouldn't poison every subsequent request.
      logger.debug({ err, tool: name }, "mnemosyne MCP call failed; resetting connection");
      reset();
      throw err;
    }
  };
}
