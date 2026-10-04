import type { ServerWebSocket } from "bun";
import type { SurfaceActor } from "../../../orchestration/workspace/surface.ts";
import { adapterFor, type VoiceConfig, type VoiceEvent } from "./providers.ts";
export type VoiceSocketData = { voice: VoiceSession };
export type AskAgent = (
  request: string,
  actor: SurfaceActor,
  conversation: string,
  signal: AbortSignal,
) => Promise<string>;
export const VOICE_SESSION_MS = 15 * 60 * 1000;
export const VOICE_BUFFER_MAX = 256 * 1024;
/** A bounded owner-only relay. No provider credentials or raw provider errors reach the browser. */
export class VoiceSession {
  private client: ServerWebSocket<VoiceSocketData> | null = null;
  private upstream: WebSocket | null = null;
  private ready = false;
  private closed = false;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private setupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly calls = new Map<string, AbortController>();
  private readonly seenCalls = new Set<string>();
  private responseActive = false;
  private responseId = "";
  private interruptedResponses = new Set<string>();
  private userSpeaking = false;
  private playing = false;
  private pending: unknown[][] = [];
  private lastVoicedInput = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly adapter;
  constructor(
    readonly config: VoiceConfig,
    private actor: SurfaceActor,
    private conversation: string,
    private ask: AskAgent,
    private onclose: () => void,
    private connect: (
      url: string,
      headers: Record<string, string>,
    ) => WebSocket = (url, headers) =>
      new (
        WebSocket as unknown as new (
          url: string,
          options: Bun.WebSocketOptions,
        ) => WebSocket
      )(url, { headers }),
  ) {
    this.adapter = adapterFor(config);
  }
  open(client: ServerWebSocket<VoiceSocketData>) {
    if (this.closed) return client.close(1000);
    this.client = client;
    this.deadline = setTimeout(
      () => this.fail("The 15-minute voice session ended. Start a new call."),
      VOICE_SESSION_MS,
    );
    this.setupTimer = setTimeout(
      () => this.fail("Couldn't connect to the voice provider. Try again."),
      15000,
    );
    let upstream: WebSocket;
    try {
      upstream = this.connect(this.adapter.url, this.adapter.headers);
    } catch {
      this.fail("Couldn't connect to the voice provider.");
      return;
    }
    this.upstream = upstream;
    upstream.onopen = () => this.send(this.adapter.setup());
    upstream.onmessage = (event) => {
      if (this.closed) return;
      try {
        const data =
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data);
        for (const e of this.adapter.events(JSON.parse(data))) this.event(e);
      } catch {
        this.fail("The voice provider sent an invalid response.");
      }
    };
    upstream.onerror = () =>
      this.fail(
        "Couldn't connect to the voice provider. Check the server credentials.",
      );
    upstream.onclose = () => {
      if (!this.closed) this.fail("Voice connection closed. Start a new call.");
    };
  }
  private emit(
    event: VoiceEvent | { type: "agent"; state: "working" | "done" },
  ) {
    if (this.closed || !this.client) return;
    if (this.client.getBufferedAmount() > VOICE_BUFFER_MAX) {
      this.close();
      return;
    }
    this.client.send(JSON.stringify(event));
  }
  private send(event: unknown) {
    if (this.closed || this.upstream?.readyState !== WebSocket.OPEN) return;
    if (this.upstream.bufferedAmount > VOICE_BUFFER_MAX) {
      this.fail("Voice connection is too slow. Try again.");
      return;
    }
    this.upstream.send(JSON.stringify(event));
  }
  private event(event: VoiceEvent) {
    if (event.type === "ready") {
      if (this.ready) return;
      this.ready = true;
      if (this.setupTimer) clearTimeout(this.setupTimer);
      this.setupTimer = null;
    }
    if (event.type === "error") {
      this.fail(event.message);
      return;
    }
    // An interrupted utterance does not revoke a backend request already accepted into chat.
    if (event.type === "tool_cancel") return;
    if (event.type === "response_started") {
      this.responseActive = true;
      this.responseId = event.id;
      return;
    }
    if (
      event.type === "audio" &&
      event.responseId &&
      this.interruptedResponses.has(event.responseId)
    )
      return;
    if (event.type === "audio") {
      this.playing = true;
      this.responseActive = true;
    }
    if (event.type === "interrupted") {
      this.playing = false;
      this.userSpeaking = true;
      if (this.responseId) this.interruptedResponses.add(this.responseId);
      if (this.interruptedResponses.size > 100)
        this.interruptedResponses.delete(
          this.interruptedResponses.values().next().value!,
        );
    }
    if (event.type === "speech_end") {
      this.userSpeaking = false;
      return;
    }
    if (event.type === "turn_done") {
      this.responseActive = false;
      this.flush();
    }
    if (event.type === "tool") {
      void this.tool(event);
      return;
    }
    this.emit(event);
  }
  private async tool(event: Extract<VoiceEvent, { type: "tool" }>) {
    if (this.seenCalls.has(event.id)) return;
    this.seenCalls.add(event.id);
    if (this.seenCalls.size > 100) {
      this.fail("Voice session reached its turn limit. Start a new call.");
      return;
    }
    const args = event.args as { request?: unknown } | null;
    let output = "This tool call is not supported.";
    if (
      event.name === "ask_sushii" &&
      typeof args?.request === "string" &&
      args.request.trim() &&
      args.request.length <= 12000
    ) {
      if (this.calls.size)
        output =
          "Sushii is still working on the previous request. Wait for its answer; do not claim another request was sent.";
      else {
        const abort = new AbortController();
        this.calls.set(event.id, abort);
        this.emit({ type: "agent", state: "working" });
        // Acknowledge immediately. Realtime conversation continues while the existing agent works.
        const messages = this.adapter.toolResult(
          event.id,
          "Request accepted. Sushii is working in the web chat. You can keep talking; its result will be announced when ready. Approvals stay in the web chat.",
        );
        this.queueToolResult(messages);
        void this.ask(args.request, this.actor, this.conversation, abort.signal)
          .catch(
            () =>
              "Sushii couldn't finish this request. Check the web chat for status or approvals, then try again.",
          )
          .then((result) => {
            if (abort.signal.aborted || this.closed) return;
            this.calls.delete(event.id);
            this.emit({ type: "agent", state: "done" });
            this.pending.push(this.adapter.result(result.slice(0, 24000)));
            this.flush();
          });
        return;
      }
    }
    this.queueToolResult(
      this.adapter.toolResult(event.id, output.slice(0, 24000)),
    );
  }
  private queueToolResult(messages: unknown[]) {
    const first = messages[0];
    this.send(first);
    if (this.config.id === "gemini") this.responseActive = true;
    if (messages.length > 1) {
      this.pending.push(messages.slice(1));
      this.flush();
    }
  }
  private flush() {
    if (this.closed || this.responseActive || this.userSpeaking || this.playing)
      return;
    // Gemini does not always emit a speech-start event outside an interruption.
    // A short local quiet window also keeps background announcements out of ongoing speech.
    const quietIn = 700 - (Date.now() - this.lastVoicedInput);
    if (this.pending.length && quietIn > 0) {
      if (this.quietTimer) clearTimeout(this.quietTimer);
      this.quietTimer = setTimeout(() => {
        this.quietTimer = null;
        this.flush();
      }, quietIn);
      return;
    }
    const messages = this.pending.shift();
    if (!messages) return;
    this.responseActive = true;
    for (const message of messages) this.send(message);
  }
  message(data: string | Buffer) {
    if (!this.ready || this.closed) return;
    if (data.length > 32000) {
      this.fail("Voice audio packet was too large.");
      return;
    }
    try {
      const message = JSON.parse(data.toString());
      if (message.type === "playback_idle") {
        this.playing = false;
        this.flush();
        return;
      }
      // The client cannot send provider commands, change instructions, or execute arbitrary tools.
      if (
        message.type !== "audio" ||
        typeof message.audio !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(message.audio) ||
        message.audio.length % 4 !== 0
      ) {
        this.fail("Invalid voice audio packet.");
        return;
      }
      const pcm = Buffer.from(message.audio, "base64");
      if (!pcm.length || pcm.length % 2) {
        this.fail("Invalid voice audio packet.");
        return;
      }
      let energy = 0;
      for (let i = 0; i < pcm.length; i += 2)
        energy += (pcm.readInt16LE(i) / 32768) ** 2;
      if (Math.sqrt(energy / (pcm.length / 2)) > 0.02)
        this.lastVoicedInput = Date.now();
      this.send(this.adapter.audio(message.audio));
    } catch {
      this.fail("Invalid voice audio packet.");
    }
  }
  private fail(message: string) {
    this.emit({ type: "error", message });
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.deadline) clearTimeout(this.deadline);
    if (this.setupTimer) clearTimeout(this.setupTimer);
    for (const abort of this.calls.values()) abort.abort();
    this.calls.clear();
    this.upstream?.close();
    this.client?.close(1000, "Voice session ended");
    this.onclose();
  }
}
