import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getActivityHub } from "./activityHub.ts";

// marked (GFM parse) + DOMPurify (sanitize), inlined from node_modules so the viewer stays a single
// self-contained page (no runtime CDN). Injected into the page by string concatenation — NOT inside a
// template literal — because the minified library source contains backticks and ${...}. The </script>
// guard prevents an accidental early tag close if a lib string literal contains that sequence.
const req = createRequire(import.meta.url);
function loadLib(pkg: string, rel: string): string {
  const src = readFileSync(join(dirname(req.resolve(pkg + "/package.json")), rel), "utf8");
  return src.replace(/<\/script>/gi, "<\\/script>");
}
const MARKDOWN_LIB_JS =
  "<script>" + loadLib("marked", "lib/marked.umd.js") + "\n" + loadLib("dompurify", "dist/purify.min.js") + "</script>";

// Live task viewer: a per-task keyed URL that streams the activity as it happens. The key is the
// unguessable per-task token minted by the ActivityHub; it is the whole auth (owner-only data, and
// the token never leaves the owner's Discord DM / dispatch result). Two routes:
//   GET /tasks/:id?key=…         → a self-contained HTML page that live-renders the stream
//   GET /tasks/:id/stream?key=…  → the SSE stream (buffered backlog, then live lines, then status)
export function registerTaskStreamRoutes(app: Hono): void {
  app.get("/tasks/:id/stream", (c) => {
    const id = c.req.param("id");
    const view = getActivityHub().viewWithToken(id, c.req.query("key") ?? "");
    if (!view) return c.json({ error: "not_found" }, 404);

    // On an EventSource reconnect the browser replays Last-Event-ID; resume after it so the backlog
    // isn't re-sent (which duplicated the whole log when the stream closed on settle).
    const lastId = Number(c.req.header("Last-Event-ID") ?? c.req.query("lastId") ?? "0") || 0;

    return streamSSE(c, async (stream) => {
      if (view.meta) await stream.writeSSE({ event: "meta", data: JSON.stringify(view.meta) });
      for (const l of view.lines) {
        if (l.seq > lastId) await stream.writeSSE({ id: String(l.seq), data: JSON.stringify(l) });
      }
      if (view.status !== "running") {
        await stream.writeSSE({ event: "status", data: JSON.stringify({ status: view.status, summary: view.summary }) });
        return; // already settled — backlog delivered, nothing more will come
      }
      // Hold the stream open, forwarding lines live and closing promptly on settle or disconnect.
      // A separate heartbeat keeps the connection alive without blocking the close.
      await new Promise<void>((resolve) => {
        let closed = false;
        const heartbeat = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), 15000);
        const unsubLine = view.onLine((l) => void stream.writeSSE({ id: String(l.seq), data: JSON.stringify(l) }).catch(() => {}));
        const unsubStatus = view.onStatus((status, summary) => {
          void stream.writeSSE({ event: "status", data: JSON.stringify({ status, summary }) }).catch(() => {});
          finish();
        });
        function finish(): void {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubLine();
          unsubStatus();
          resolve();
        }
        stream.onAbort(finish);
      });
    });
  });

  app.get("/tasks/:id", (c) => {
    const id = c.req.param("id");
    if (!getActivityHub().viewWithToken(id, c.req.query("key") ?? "")) {
      // Either a bad key or a stream that has expired (the buffer is per-process + short-lived).
      return c.html(EXPIRED_HTML, 404);
    }
    // Function replacements: the lib source contains $&/$1/$` which a string replacement would mangle.
    const page = VIEWER_HTML.replace("</head>", () => MARKDOWN_LIB_JS + "</head>").replaceAll("__TASK_ID__", () => escapeHtml(id));
    return c.html(page);
  });
}

const EXPIRED_HTML = `<!doctype html><meta charset="utf-8"/><title>Stream unavailable</title>
<body style="background:#0d1117;color:#c9d1d9;font:14px/1.6 ui-monospace,monospace;padding:40px">
This task's live stream has expired or the link is invalid. Live streams are kept only while a task
runs and for a short window after; the task's summary is in Discord.</body>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
}

// Self-contained live transcript viewer, styled after the Claude Code transcript in a Catppuccin
// palette (Mocha dark by default, Latte under prefers-color-scheme:light, plus a per-viewer toggle).
// Assistant text renders as prose; each tool call is a card whose result folds underneath, revealed
// on click. De-dups by sequence id, honors Last-Event-ID resume, auto-scrolls unless scrolled up.
const VIEWER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Task __TASK_ID__</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Nunito:wght@500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --base:#1e1e2e; --mantle:#181825; --crust:#11111b;
    --surface0:#313244; --surface1:#45475a; --surface2:#585b70;
    --overlay0:#6c7086; --overlay1:#7f849c; --overlay2:#9399b2;
    --text:#cdd6f4; --subtext1:#bac2de; --subtext0:#a6adc8;
    --blue:#89b4fa; --lavender:#b4befe; --sapphire:#74c7ec; --sky:#89dceb; --teal:#94e2d5;
    --green:#a6e3a1; --yellow:#f9e2af; --peach:#fab387; --maroon:#eba0ac; --red:#f38ba8;
    --mauve:#cba6f7; --pink:#f5c2e7; --flamingo:#f2cdcd; --rosewater:#f5e0dc;
    --shadow: 0 10px 30px -12px rgba(17,17,27,.7), 0 2px 8px -4px rgba(17,17,27,.6);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) {
      --base:#eff1f5; --mantle:#e6e9ef; --crust:#dce0e8;
      --surface0:#ccd0da; --surface1:#bcc0cc; --surface2:#acb0be;
      --overlay0:#9ca0b0; --overlay1:#8c8fa1; --overlay2:#7c7f93;
      --text:#4c4f69; --subtext1:#5c5f77; --subtext0:#6c6f85;
      --blue:#1e66f5; --lavender:#7287fd; --sapphire:#209fb5; --sky:#04a5e5; --teal:#179299;
      --green:#40a02b; --yellow:#df8e1d; --peach:#fe640b; --maroon:#e64553; --red:#d20f39;
      --mauve:#8839ef; --pink:#ea76cb; --flamingo:#dd7878; --rosewater:#dc8a78;
      --shadow: 0 10px 30px -14px rgba(76,79,105,.28), 0 2px 8px -5px rgba(76,79,105,.22);
      color-scheme: light;
    }
  }
  :root[data-theme="dark"] {
    --base:#1e1e2e; --mantle:#181825; --crust:#11111b;
    --surface0:#313244; --surface1:#45475a; --surface2:#585b70;
    --overlay0:#6c7086; --overlay1:#7f849c; --overlay2:#9399b2;
    --text:#cdd6f4; --subtext1:#bac2de; --subtext0:#a6adc8;
    --blue:#89b4fa; --lavender:#b4befe; --sapphire:#74c7ec; --sky:#89dceb; --teal:#94e2d5;
    --green:#a6e3a1; --yellow:#f9e2af; --peach:#fab387; --maroon:#eba0ac; --red:#f38ba8;
    --mauve:#cba6f7; --pink:#f5c2e7; --flamingo:#f2cdcd; --rosewater:#f5e0dc;
    color-scheme: dark;
  }
  * { box-sizing:border-box; }
  html { scrollbar-color: var(--surface2) transparent; }
  body {
    margin:0; color:var(--text);
    background:
      radial-gradient(1200px 600px at 80% -10%, color-mix(in srgb, var(--mauve) 10%, transparent), transparent 60%),
      radial-gradient(900px 500px at -10% 0%, color-mix(in srgb, var(--blue) 8%, transparent), transparent 55%),
      var(--base);
    background-attachment: fixed;
    font-family:"Nunito", ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  ::selection { background: color-mix(in srgb, var(--mauve) 34%, transparent); }
  ::-webkit-scrollbar { width:12px; height:12px; }
  ::-webkit-scrollbar-thumb { background:var(--surface1); border:3px solid transparent; background-clip:content-box; border-radius:20px; }
  ::-webkit-scrollbar-thumb:hover { background:var(--surface2); background-clip:content-box; }
  a { color:var(--blue); }
  :focus-visible { outline:2px solid var(--blue); outline-offset:2px; border-radius:6px; }
  .wrap { max-width:900px; margin:0 auto; padding:0 16px 40vh; }

  header {
    position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:12px;
    padding:14px 16px; margin:0 -16px;
    background: color-mix(in srgb, var(--mantle) 82%, transparent);
    backdrop-filter: blur(12px) saturate(1.2);
    border-bottom:1px solid color-mix(in srgb, var(--surface0) 70%, transparent);
  }
  .brand { display:flex; align-items:center; gap:10px; min-width:0; }
  .cat { width:30px; height:30px; flex:0 0 auto; filter: drop-shadow(0 2px 4px rgba(17,17,27,.35)); }
  .titles { display:flex; flex-direction:column; line-height:1.05; min-width:0; }
  .titles .k { font-size:11px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--overlay2); }
  .idchip { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:13px; font-weight:600; color:var(--lavender); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .status { margin-left:auto; display:inline-flex; align-items:center; gap:7px; padding:5px 12px 5px 10px; border-radius:999px;
    font-size:12.5px; font-weight:700; background:var(--surface0); color:var(--subtext1); text-transform:capitalize;
    border:1px solid color-mix(in srgb, var(--surface2) 60%, transparent); }
  .status .dot { width:8px; height:8px; border-radius:50%; background:currentColor; }
  .status.running { color:var(--yellow); background: color-mix(in srgb, var(--yellow) 14%, var(--surface0)); }
  .status.running .dot { animation: pulse 1.6s ease-out infinite; }
  .status.idle, .status.done { color:var(--green); background: color-mix(in srgb, var(--green) 15%, var(--surface0)); }
  .status.failed { color:var(--red); background: color-mix(in srgb, var(--red) 16%, var(--surface0)); }
  .status.disconnected, .status.connecting { color:var(--overlay2); }
  @keyframes pulse { 0%{ box-shadow:0 0 0 0 color-mix(in srgb, currentColor 60%, transparent);} 70%{ box-shadow:0 0 0 7px transparent;} 100%{ box-shadow:0 0 0 0 transparent;} }
  .themetoggle { display:inline-grid; place-items:center; width:32px; height:32px; border-radius:9px; cursor:pointer;
    background:var(--surface0); border:1px solid color-mix(in srgb,var(--surface2) 60%, transparent); color:var(--subtext0); }
  .themetoggle:hover { color:var(--text); border-color:var(--overlay0); }
  .themetoggle svg { width:16px; height:16px; }

  .meta { display:flex; flex-wrap:wrap; gap:8px; padding:14px 0 4px; }
  .meta:empty { display:none; }
  .pill { display:inline-flex; align-items:center; gap:7px; padding:6px 11px; border-radius:10px;
    background: color-mix(in srgb, var(--mantle) 70%, transparent); border:1px solid color-mix(in srgb,var(--surface0) 80%, transparent);
    font-size:12.5px; color:var(--subtext0); }
  .pill svg { width:14px; height:14px; color:var(--overlay2); flex:0 0 auto; }
  .pill b { color:var(--text); font-weight:700; }
  .pill .mono { font-family:"JetBrains Mono",ui-monospace,monospace; font-weight:500; }

  .resume { display:none; margin:10px 0 4px; border:1px solid color-mix(in srgb,var(--surface0) 80%, transparent); border-radius:14px; overflow:hidden; background: color-mix(in srgb, var(--mantle) 60%, transparent); }
  .resume summary { list-style:none; cursor:pointer; display:flex; align-items:center; gap:9px; padding:11px 13px; font-size:13px; font-weight:700; color:var(--subtext1); }
  .resume summary::-webkit-details-marker { display:none; }
  .resume summary .lead { width:15px; height:15px; color:var(--peach); }
  .resume summary .chev { margin-left:auto; width:16px; height:16px; color:var(--overlay1); transition:transform .2s ease; }
  .resume[open] summary .chev { transform:rotate(90deg); }
  .resume .body { padding:0 13px 13px; }
  .resume .cmd { display:flex; align-items:stretch; gap:8px; }
  .resume pre { margin:0; flex:1 1 auto; min-width:0; padding:11px 13px; background:var(--crust); border:1px solid color-mix(in srgb,var(--surface0) 70%, transparent); border-radius:10px;
    font-family:"JetBrains Mono",ui-monospace,monospace; font-size:12.5px; color:var(--sky); overflow:auto; }
  .copy { flex:0 0 auto; padding:0 14px; border-radius:10px; cursor:pointer; font:inherit; font-weight:700; font-size:12.5px;
    background:var(--surface0); color:var(--subtext1); border:1px solid color-mix(in srgb,var(--surface2) 60%, transparent); }
  .copy:hover { color:var(--text); border-color:var(--mauve); }

  main { padding-top:8px; }
  .entry { animation: rise .34s cubic-bezier(.22,1,.36,1) both; }
  @keyframes rise { from { opacity:0; transform:translateY(7px); } to { opacity:1; transform:none; } }
  .say { display:flex; gap:12px; padding:9px 2px; }
  .say .bullet { flex:0 0 auto; margin-top:6px; width:9px; height:9px; border-radius:50%;
    background: radial-gradient(circle at 35% 30%, var(--rosewater), var(--pink)); box-shadow:0 0 10px -1px color-mix(in srgb,var(--pink) 60%, transparent); }
  .say .prose { color:var(--text); font-size:14.5px; line-height:1.62; max-width:72ch; word-break:break-word; min-width:0; }

  /* markdown (assistant text + handback summary), rendered by marked → real h1-h6/pre/blockquote/hr */
  .md > :first-child { margin-top:0; } .md > :last-child { margin-bottom:0; }
  .md p { margin:0 0 8px; }
  .md h1, .md h2, .md h3, .md h4, .md h5, .md h6 { font-weight:800; color:var(--text); margin:12px 0 6px; line-height:1.3; }
  .md h1 { font-size:19px; } .md h2 { font-size:17px; } .md h3 { font-size:15px; }
  .md h4, .md h5, .md h6 { font-size:14px; color:var(--subtext1); }
  .md ul, .md ol { margin:4px 0 8px; padding-left:22px; } .md li { margin:2px 0; }
  .md ul { list-style:none; } .md ul > li::before { content:"•"; color:var(--mauve); font-weight:800; display:inline-block; width:1em; margin-left:-1em; }
  .md ol { list-style:decimal; } .md ol li::marker { color:var(--overlay2); }
  .md a { color:var(--blue); text-decoration:underline; text-underline-offset:2px; text-decoration-color:color-mix(in srgb,var(--blue) 45%, transparent); }
  .md a:hover { text-decoration-color:var(--blue); }
  .md strong { color:var(--text); font-weight:800; } .md em { font-style:italic; color:var(--subtext1); }
  .md code { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:.88em; padding:1.5px 5px; border-radius:5px;
    background: color-mix(in srgb, var(--surface0) 70%, transparent); color:var(--peach); }
  .md pre { margin:8px 0; padding:11px 13px; background:var(--crust); border:1px solid color-mix(in srgb,var(--surface0) 70%, transparent);
    border-radius:10px; overflow:auto; }
  .md pre code { background:none; padding:0; color:var(--sky); font-size:12px; line-height:1.55; white-space:pre; }
  .md blockquote { margin:8px 0; padding:2px 0 2px 12px; border-left:2px solid var(--mauve); color:var(--subtext1); }
  .md hr { border:none; border-top:1px solid var(--surface1); margin:12px 0; }
  .md table { border-collapse:collapse; margin:8px 0; font-size:13px; } .md th, .md td { border:1px solid var(--surface1); padding:5px 9px; text-align:left; } .md th { color:var(--text); font-weight:700; background:color-mix(in srgb,var(--surface0) 40%, transparent); }

  .tool { padding:5px 2px; }
  .tool .call { display:flex; align-items:center; gap:10px; padding:8px 11px; border-radius:11px;
    background: color-mix(in srgb, var(--mantle) 55%, transparent); border:1px solid color-mix(in srgb,var(--surface0) 60%, transparent); }
  .tool.expandable .call { cursor:pointer; }
  .tool.expandable .call:hover { border-color:color-mix(in srgb,var(--mauve) 55%, var(--surface0)); background: color-mix(in srgb, var(--mantle) 78%, transparent); }
  .tool .ico { flex:0 0 auto; display:grid; place-items:center; width:26px; height:26px; border-radius:8px;
    background: color-mix(in srgb, var(--mauve) 16%, var(--surface0)); color:var(--mauve); }
  .tool .ico svg { width:15px; height:15px; }
  .tool .name { font-weight:800; color:var(--mauve); font-size:13.5px; flex:0 0 auto; }
  .tool .args { font-family:"JetBrains Mono",ui-monospace,monospace; font-size:12.5px; color:var(--subtext0);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .tool .ts { margin-left:auto; flex:0 0 auto; font-family:"JetBrains Mono",ui-monospace,monospace; font-size:11px;
    color:var(--overlay2); font-variant-numeric:tabular-nums; -webkit-user-select:none; user-select:none; }
  .tool .chev { flex:0 0 auto; color:var(--overlay1); transition:transform .2s ease; display:grid; place-items:center; }
  .tool .chev svg { width:14px; height:14px; }
  .tool.open .chev { transform:rotate(90deg); }
  .result { display:grid; grid-template-rows:0fr; transition:grid-template-rows .24s ease; margin-left:37px; }
  .tool.open .result { grid-template-rows:1fr; }
  .result > .inner { overflow:hidden; min-height:0; }
  .result pre { margin:8px 0 2px; padding:10px 12px; background:var(--crust);
    border:1px solid color-mix(in srgb,var(--surface0) 70%, transparent); border-left:2px solid var(--surface2); border-radius:10px;
    font-family:"JetBrains Mono",ui-monospace,monospace; font-size:12px; line-height:1.5; color:var(--subtext0);
    white-space:pre-wrap; word-break:break-word; max-height:44vh; overflow:auto; }
  .tool.err .ico { background: color-mix(in srgb, var(--red) 18%, var(--surface0)); color:var(--red); }
  .tool.err .name { color:var(--red); }
  .tool.err .result pre { border-left-color:var(--red); }

  .final { margin:16px 0 0; padding:14px 16px; border-radius:14px; background: color-mix(in srgb, var(--mantle) 75%, transparent);
    border:1px solid color-mix(in srgb,var(--surface0) 80%, transparent); box-shadow:var(--shadow); }
  .final .lbl { display:flex; align-items:center; gap:8px; font-size:11px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; color:var(--green); margin-bottom:7px; }
  .final.failed .lbl { color:var(--red); }
  .final .lbl svg { width:14px; height:14px; }
  .final .txt { color:var(--text); font-size:14px; line-height:1.6; word-break:break-word; }

  .empty { display:flex; flex-direction:column; align-items:center; gap:14px; padding:16vh 0 0; color:var(--overlay1); text-align:center; }
  .empty svg { width:64px; height:64px; animation: bob 3.4s ease-in-out infinite; }
  .empty p { margin:0; font-size:14px; font-weight:600; }
  .empty .sub { font-size:12.5px; color:var(--overlay0); font-weight:500; }
  @keyframes bob { 0%,100%{ transform:translateY(0);} 50%{ transform:translateY(-6px);} }

  @media (prefers-reduced-motion: reduce) {
    .entry, .empty svg, .status.running .dot { animation:none; }
    .result, .resume summary .chev, .tool .chev { transition:none; }
  }
  @media (max-width:560px) { .tool .ts { display:none; } .say .prose { font-size:14px; } header { gap:9px; } }
</style></head>
<body>
<div class="wrap">
  <header>
    <span class="brand">
      <svg class="cat" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path d="M6 12 4.5 5.5 10 9.2M26 12l1.5-6.5L22 9.2" fill="var(--mauve)" stroke="var(--mauve)" stroke-width="1.4" stroke-linejoin="round"/>
        <path d="M16 7.5c-6 0-10.5 4.4-10.5 10.2C5.5 23.8 10 27 16 27s10.5-3.2 10.5-9.3C26.5 11.9 22 7.5 16 7.5Z" fill="var(--surface0)" stroke="var(--mauve)" stroke-width="1.4"/>
        <circle cx="12" cy="17" r="1.5" fill="var(--sky)"/><circle cx="20" cy="17" r="1.5" fill="var(--sky)"/>
        <path d="M16 20.2v1.1M13.7 21.4c.7.6 1.9.6 2.3 0 .4.6 1.6.6 2.3 0" stroke="var(--pink)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
        <path d="M8.5 19.3 5.6 18.7M8.6 21l-2.6.9M23.5 19.3l2.9-.6M23.4 21l2.6.9" stroke="var(--overlay1)" stroke-width="1.1" stroke-linecap="round"/>
      </svg>
      <span class="titles"><span class="k">Runner task</span><span class="idchip">#__TASK_ID__</span></span>
    </span>
    <button class="themetoggle" id="themebtn" title="Toggle theme" aria-label="Toggle theme">
      <svg id="themeicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>
    </button>
    <span class="status connecting" id="status"><span class="dot"></span><span id="statustext">connecting…</span></span>
  </header>
  <div class="meta" id="meta"></div>
  <details class="resume" id="resume"><summary>
    <svg class="lead" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
    Resume from a terminal
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>
  </summary><div class="body"><div class="cmd"><pre id="resumecmd"></pre><button class="copy" id="copy">Copy</button></div></div></details>
  <main id="log"><div class="empty"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M6 12 4.5 5.5 10 9.2M26 12l1.5-6.5L22 9.2" fill="var(--mauve)" stroke="var(--mauve)" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M16 7.5c-6 0-10.5 4.4-10.5 10.2C5.5 23.8 10 27 16 27s10.5-3.2 10.5-9.3C26.5 11.9 22 7.5 16 7.5Z" fill="var(--surface0)" stroke="var(--mauve)" stroke-width="1.4"/>
    <circle cx="12" cy="17" r="1.5" fill="var(--sky)"/><circle cx="20" cy="17" r="1.5" fill="var(--sky)"/>
    <path d="M13.7 20.6c.7.6 1.9.6 2.3 0 .4.6 1.6.6 2.3 0" stroke="var(--pink)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
  </svg><p>Waiting for the first step…</p><span class="sub">the agent's activity will stream in here</span></div></main>
</div>
<script>
  const log=document.getElementById('log'), statusEl=document.getElementById('status'), statusText=document.getElementById('statustext');
  let lastSeq=0, pendingTool=null, hasContent=false;
  const pad=n=>String(n).padStart(2,'0');
  const fmtTs=ms=>{const d=new Date(ms);let h=d.getHours();const ap=h<12?'AM':'PM';h=h%12||12;return h+':'+pad(d.getMinutes())+':'+pad(d.getSeconds())+' '+ap;};
  const atBottom=()=>window.innerHeight+window.scrollY>=document.body.scrollHeight-80;
  const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  // Markdown for assistant text + handback summaries: marked (GFM) → DOMPurify sanitize. The libs are
  // inlined in <head>; if either is missing we fall back to escaped plain text.
  if (window.DOMPurify) DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') { node.setAttribute('target','_blank'); node.setAttribute('rel','noopener noreferrer'); }
  });
  function md(src){
    const s = String(src == null ? '' : src);
    // A text transcript needs no embedded media/forms; forbidding them avoids broken images and any
    // external request (privacy/SSRF) on top of DOMPurify's XSS stripping.
    try { return DOMPurify.sanitize(marked.parse(s, { gfm:true, breaks:true, async:false }),
      { FORBID_TAGS:['img','video','audio','iframe','svg','math','form','input','style'] }); }
    catch { return esc(s); }
  }
  const svg=(inner)=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">'+inner+'</svg>';
  const I={
    terminal:'<polyline points="5 8 9 12 5 16"/><line x1="12" y1="16" x2="18" y2="16"/>',
    read:'<path d="M7 4h7l4 4v12H7z"/><polyline points="14 4 14 8 18 8"/>',
    edit:'<path d="M5 19h4l9-9-4-4-9 9z"/><line x1="13" y1="7" x2="17" y2="11"/>',
    search:'<circle cx="11" cy="11" r="6"/><line x1="20" y1="20" x2="15.5" y2="15.5"/>',
    git:'<circle cx="7" cy="6" r="2.4"/><circle cx="7" cy="18" r="2.4"/><circle cx="17" cy="9" r="2.4"/><path d="M7 8.4v7.2M9.2 7.6c4 .6 5.6 1.6 5.9 4"/>',
    web:'<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.4 2.5 13.6 0 16M12 4c-2.5 2.4-2.5 13.6 0 16"/>',
    dot:'<circle cx="12" cy="12" r="3.2"/>'
  };
  function iconFor(name){
    const n=(name||'').toLowerCase();
    if(/(bash|shell|exec|sh|run|command)/.test(n)) return I.terminal;
    if(/(read|cat|view|open)/.test(n)) return I.read;
    if(/(edit|write|apply|patch|create|update)/.test(n)) return I.edit;
    if(/(grep|search|find|glob|rg)/.test(n)) return I.search;
    if(/(git|commit|push|pr|branch)/.test(n)) return I.git;
    if(/(fetch|web|curl|http|gh)/.test(n)) return I.web;
    return I.dot;
  }
  function splitCall(line){const s=String(line);const i=s.indexOf(' ');return i<0?[s,'']:[s.slice(0,i),s.slice(i+1)];}
  function stick(was){ if(was) window.scrollTo(0,document.body.scrollHeight); }
  function clearEmpty(){ if(!hasContent){ log.innerHTML=''; hasContent=true; } }

  function add(entry){
    if(entry.seq){ if(entry.seq<=lastSeq) return; lastSeq=entry.seq; }
    const was=atBottom();
    if(entry.atype==='result'){
      const h=pendingTool; pendingTool=null;
      if(h){
        h.pre.textContent=entry.line;
        h.tool.classList.add('expandable');
        if(/^✗/.test(entry.line)) h.tool.classList.add('err');
        h.tool.querySelector('.call').addEventListener('click',()=>h.tool.classList.toggle('open'));
      }
      stick(was); return;
    }
    clearEmpty();
    const wrap=document.createElement('div'); wrap.className='entry';
    if(entry.atype==='tool'){
      const parts=splitCall(entry.line); const name=parts[0], args=parts[1];
      const tool=document.createElement('div'); tool.className='tool';
      tool.innerHTML='<div class="call"><span class="ico">'+svg(iconFor(name))+'</span>'
        +'<span class="name">'+esc(name)+'</span><span class="args">'+esc(args)+'</span>'
        +'<span class="ts">'+(entry.at?fmtTs(entry.at):'')+'</span>'
        +'<span class="chev">'+svg('<polyline points="9 6 15 12 9 18"/>')+'</span></div>'
        +'<div class="result"><div class="inner"><pre></pre></div></div>';
      wrap.appendChild(tool); log.appendChild(wrap);
      pendingTool={ tool, pre:tool.querySelector('pre') };
    } else {
      const say=document.createElement('div'); say.className='say';
      say.innerHTML='<span class="bullet"></span><div class="prose md">'+md(entry.line)+'</div>';
      wrap.appendChild(say); log.appendChild(wrap);
    }
    stick(was);
  }

  const es=new EventSource('/tasks/__TASK_ID__/stream' + location.search);
  es.onmessage=(e)=>{ try { add(JSON.parse(e.data)); } catch {} };
  es.addEventListener('meta',(e)=>{
    try {
      const m=JSON.parse(e.data), el=document.getElementById('meta');
      const pill=(ico,label,val,mono)=>val?('<span class="pill">'+svg(ico)+'<span>'+label+' <b class="'+(mono?'mono':'')+'">'+esc(val)+'</b></span></span>'):'';
      el.innerHTML=pill(I.dot,'runner',(m.runnerId||'')+(m.kind?' · '+m.kind:''))
        +pill(I.web,'where',m.location)
        +pill(I.git,'project',m.project)
        +pill(I.read,'path',m.cwd?('…/'+String(m.cwd).split('/').slice(-2).join('/')):null,true);
      if(m.resumeCommand){
        document.getElementById('resumecmd').textContent=m.resumeCommand;
        document.getElementById('resume').style.display='block';
        document.getElementById('copy').onclick=()=>navigator.clipboard.writeText(m.resumeCommand).then(()=>{ const b=document.getElementById('copy'); b.textContent='Copied ✓'; setTimeout(()=>b.textContent='Copy',1200); });
      }
    } catch {}
  });
  es.addEventListener('status',(e)=>{
    try {
      const s=JSON.parse(e.data); statusText.textContent=s.status; statusEl.className='status '+s.status;
      if(s.summary){
        const was=atBottom();
        const d=document.createElement('div'); d.className='final '+(s.status==='failed'?'failed':'');
        const ic=s.status==='failed'?'<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.3" x2="12" y2="16.4"/>':'<polyline points="20 6 9 17 4 12"/>';
        d.innerHTML='<div class="lbl">'+svg(ic)+(s.status==='failed'?'Failed':'Handback')+'</div><div class="txt md">'+md(s.summary)+'</div>';
        clearEmpty(); log.appendChild(d); stick(was);
      }
    } catch {}
    es.close(); // settled — stop, and stop the browser from reconnecting
  });
  es.onopen=()=>{ if(statusEl.classList.contains('connecting')){ statusText.textContent='running'; statusEl.className='status running'; } };
  es.onerror=()=>{ const s=statusEl.className; if(es.readyState===2 && !/idle|done|failed/.test(s)){ statusText.textContent='disconnected'; statusEl.className='status disconnected'; } };

  const themebtn=document.getElementById('themebtn');
  const sun='<circle cx="12" cy="12" r="4.2"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>';
  const moon='<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/>';
  function paintThemeIcon(){ document.getElementById('themeicon').innerHTML=(document.documentElement.getAttribute('data-theme')==='light')?moon:sun; }
  try { const saved=localStorage.getItem('viewer-theme'); if(saved) document.documentElement.setAttribute('data-theme',saved); } catch {}
  paintThemeIcon();
  themebtn.onclick=()=>{
    const cur=document.documentElement.getAttribute('data-theme');
    const isLight = cur ? cur==='light' : matchMedia('(prefers-color-scheme: light)').matches;
    document.documentElement.setAttribute('data-theme', isLight?'dark':'light');
    try { localStorage.setItem('viewer-theme', isLight?'dark':'light'); } catch {}
    paintThemeIcon();
  };
</script>
</body></html>`;
