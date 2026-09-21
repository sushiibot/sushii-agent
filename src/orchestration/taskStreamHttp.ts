import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getActivityHub } from "./activityHub.ts";

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

    return streamSSE(c, async (stream) => {
      for (const l of view.lines) await stream.writeSSE({ data: JSON.stringify(l) });
      if (view.status !== "running") {
        await stream.writeSSE({ event: "status", data: JSON.stringify({ status: view.status, summary: view.summary }) });
        return; // already settled — backlog delivered, nothing more will come
      }
      // Hold the stream open, forwarding lines live and closing promptly on settle or disconnect.
      // A separate heartbeat keeps the connection alive without blocking the close.
      await new Promise<void>((resolve) => {
        let closed = false;
        const heartbeat = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), 15000);
        const unsubLine = view.onLine((l) => void stream.writeSSE({ data: JSON.stringify(l) }).catch(() => {}));
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
    return c.html(VIEWER_HTML.replaceAll("__TASK_ID__", escapeHtml(id)));
  });
}

const EXPIRED_HTML = `<!doctype html><meta charset="utf-8"/><title>Stream unavailable</title>
<body style="background:#0d1117;color:#c9d1d9;font:14px/1.6 ui-monospace,monospace;padding:40px">
This task's live stream has expired or the link is invalid. Live streams are kept only while a task
runs and for a short window after; the task's summary is in Discord.</body>`;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
}

// Self-contained viewer: connects to the SSE endpoint (reusing this page's ?key=…), appends lines,
// auto-scrolls unless the user has scrolled up, and shows the final status.
const VIEWER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Task __TASK_ID__</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0d1117; color:#c9d1d9; font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { position:sticky; top:0; padding:10px 14px; background:#161b22; border-bottom:1px solid #30363d; display:flex; gap:10px; align-items:center; }
  #status { padding:2px 8px; border-radius:10px; background:#21262d; font-size:12px; }
  #status.running{color:#d29922} #status.idle,#status.done{color:#3fb950} #status.failed{color:#f85149}
  main { padding:12px 14px; white-space:pre-wrap; word-break:break-word; }
  .l { padding:1px 0; } .l:hover{background:#161b22}
</style></head>
<body>
  <header><strong>#__TASK_ID__</strong><span id="status" class="running">connecting…</span></header>
  <main id="log"></main>
<script>
  const log = document.getElementById('log'), status = document.getElementById('status');
  const es = new EventSource('/tasks/__TASK_ID__/stream' + location.search);
  const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  function add(line){ const d=document.createElement('div'); d.className='l'; d.textContent=line; const stick=atBottom(); log.appendChild(d); if(stick) window.scrollTo(0,document.body.scrollHeight); }
  es.onmessage = (e) => { try { add(JSON.parse(e.data).line); } catch {} };
  es.addEventListener('status', (e) => { try { const s=JSON.parse(e.data); status.textContent=s.status; status.className=s.status; if(s.summary) add('— '+s.summary); } catch {} es.close(); });
  es.onopen = () => { if(status.textContent==='connecting…'){ status.textContent='running'; } };
  es.onerror = () => { if(status.textContent==='connecting…') status.textContent='disconnected'; };
</script>
</body></html>`;
