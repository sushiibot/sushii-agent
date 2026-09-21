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

// Self-contained log viewer: types each activity line (tool call / result / assistant text) with its
// own style + a timestamp, de-dups by sequence id, auto-scrolls unless the reader scrolled up, and
// shows the final status. Reconnect-safe (Last-Event-ID resume server-side + seq de-dup here).
const VIEWER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Task __TASK_ID__</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#c9d1d9; --dim:#8b949e; --tool:#79c0ff; --text:#e6edf3; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { position:sticky; top:0; z-index:1; padding:10px 16px; background:var(--panel); border-bottom:1px solid var(--border); display:flex; gap:12px; align-items:center; }
  header .id { font-weight:600; color:var(--text); }
  #status { margin-left:auto; padding:2px 10px; border-radius:20px; background:#21262d; font-size:12px; text-transform:capitalize; }
  #status.running{color:#d29922} #status.idle,#status.done{color:#3fb950} #status.failed{color:#f85149} #status.disconnected{color:var(--dim)}
  main { padding:8px 0 40vh; }
  .row { display:flex; gap:10px; padding:3px 16px; border-left:2px solid transparent; }
  .row:hover { background:#11151c; }
  .ts { color:#586069; flex:0 0 auto; -webkit-user-select:none; user-select:none; }
  .msg { white-space:pre-wrap; word-break:break-word; min-width:0; }
  .tool { border-left-color:var(--tool); } .tool .msg { color:var(--tool); }
  .tool.has { cursor:pointer; } .tool.has:hover { background:#151b24; }
  .hint { color:var(--dim); }
  .text .msg { color:var(--text); }
  .out { display:none; margin:1px 16px 6px 52px; padding:8px 10px; background:#0b0f14; border:1px solid var(--border); border-radius:6px; white-space:pre-wrap; word-break:break-word; color:var(--dim); max-height:40vh; overflow:auto; }
  .out.open { display:block; }
  .summary { margin:8px 16px 0; padding:10px 12px; background:var(--panel); border:1px solid var(--border); border-radius:8px; color:var(--text); white-space:pre-wrap; }
  #meta { padding:10px 16px; border-bottom:1px solid var(--border); background:#0f141b; display:none; flex-wrap:wrap; gap:6px 20px; }
  #meta.on { display:flex; }
  #meta .kv { color:var(--dim); } #meta .kv b { color:var(--fg); font-weight:600; }
  #resume { margin:10px 16px 0; display:none; }
  #resume.on { display:block; }
  #resume .bar { display:flex; gap:8px; align-items:center; margin-bottom:4px; color:var(--dim); font-size:12px; }
  #resume button { background:#21262d; color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:3px 10px; cursor:pointer; font:inherit; }
  #resume button:hover { border-color:var(--tool); }
  #resume pre { margin:0; padding:10px 12px; background:var(--panel); border:1px solid var(--border); border-radius:8px; overflow:auto; color:var(--tool); }
</style></head>
<body>
  <header><span class="id">#__TASK_ID__</span><span id="status" class="running">connecting…</span></header>
  <div id="meta"></div>
  <div id="resume"><div class="bar"><span>Resume from a terminal</span><button id="copy">Copy</button></div><pre id="resumecmd"></pre></div>
  <main id="log"></main>
<script>
  const log = document.getElementById('log'), statusEl = document.getElementById('status');
  let lastSeq = 0;
  const es = new EventSource('/tasks/__TASK_ID__/stream' + location.search);
  const atBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 60;
  const pad = (n) => String(n).padStart(2,'0');
  function ts(ms){ const d=new Date(ms); return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds()); }
  let pendingTool = null; // last tool row awaiting its result
  function add(entry){
    if(entry.seq && entry.seq<=lastSeq) return; if(entry.seq) lastSeq=entry.seq;
    const stick=atBottom();
    // A tool result attaches to its call row (revealed on click) instead of being its own noisy row.
    if(entry.atype==='result'){
      const h=pendingTool; pendingTool=null;
      if(h){ h.out.textContent=entry.line; h.row.classList.add('has'); h.hint.textContent=' ▸'; h.row.onclick=()=>{ const open=h.out.classList.toggle('open'); h.hint.textContent=open?' ▾':' ▸'; }; }
      if(stick) window.scrollTo(0,document.body.scrollHeight); return;
    }
    const row=document.createElement('div'); row.className='row '+entry.atype;
    const t=document.createElement('span'); t.className='ts'; t.textContent=entry.at?ts(entry.at):'';
    const m=document.createElement('span'); m.className='msg'; m.textContent=(entry.atype==='tool'?'🔧 ':'💬 ')+entry.line;
    const hint=document.createElement('span'); hint.className='hint';
    m.appendChild(hint); row.append(t,m); log.appendChild(row);
    if(entry.atype==='tool'){ const out=document.createElement('div'); out.className='out'; row.after(out); pendingTool={row,out,hint}; }
    if(stick) window.scrollTo(0,document.body.scrollHeight);
  }
  es.onmessage = (e) => { try { add(JSON.parse(e.data)); } catch {} };
  es.addEventListener('meta', (e) => {
    try {
      const m = JSON.parse(e.data); const el = document.getElementById('meta');
      const kv = (k,v) => v ? '<span class="kv">'+k+' <b>'+String(v).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</b></span>' : '';
      el.innerHTML = kv('runner', m.runnerId+' ('+m.kind+')') + kv('where', m.location) + kv('project', m.project) + kv('path', m.cwd);
      el.className = 'on';
      if (m.resumeCommand) {
        document.getElementById('resumecmd').textContent = m.resumeCommand;
        document.getElementById('resume').className = 'on';
        document.getElementById('copy').onclick = () => navigator.clipboard.writeText(m.resumeCommand).then(()=>{ const b=document.getElementById('copy'); b.textContent='Copied'; setTimeout(()=>b.textContent='Copy',1200); });
      }
    } catch {}
  });
  es.addEventListener('status', (e) => {
    try { const s=JSON.parse(e.data); statusEl.textContent=s.status; statusEl.className=s.status;
      if(s.summary){ const d=document.createElement('div'); d.className='summary'; d.textContent=s.summary; log.appendChild(d); if(atBottom()) window.scrollTo(0,document.body.scrollHeight); }
    } catch {}
    es.close(); // settled — stop, and stop the browser from reconnecting
  });
  es.onopen = () => { if(statusEl.textContent==='connecting…') { statusEl.textContent='running'; statusEl.className='running'; } };
  es.onerror = () => { if(es.readyState===2 && statusEl.className!=='idle' && statusEl.className!=='done' && statusEl.className!=='failed'){ statusEl.textContent='disconnected'; statusEl.className='disconnected'; } };
</script>
</body></html>`;
