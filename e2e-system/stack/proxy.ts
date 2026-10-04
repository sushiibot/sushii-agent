// Stand-in for Traefik plus the Tailscale whois forward-auth shim. It strips every client Tailscale-*
// header, sets the owner login, and dials the bot from the trusted peer address, so the bot sees
// peer = WEB_TRUSTED_PEERS exactly as it does behind the real proxy.
import http from "node:http";
import { stackConfig } from "./config.ts";

const { ports, addrs, ownerLogin } = stackConfig();

http
  .createServer((req, res) => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!/^tailscale-/i.test(k)) headers[k] = v;
    headers["tailscale-user-login"] = ownerLogin;
    headers["x-forwarded-for"] = req.socket.remoteAddress;
    const up = http.request(
      { host: addrs.bot, port: ports.web, localAddress: addrs.trustedPeer, method: req.method, path: req.url, headers },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        ur.pipe(res);
      },
    );
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(up);
    res.on("close", () => up.destroy());
  })
  .on("upgrade", (req, socket, head) => {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) if (!/^tailscale-/i.test(key)) headers[key] = value;
    headers["tailscale-user-login"] = ownerLogin;
    headers["x-forwarded-for"] = req.socket.remoteAddress;
    const upstream = http.request({ host: addrs.bot, port: ports.web, localAddress: addrs.trustedPeer, method: req.method, path: req.url, headers });
    upstream.on("upgrade", (response, peer, initial) => {
      const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
      for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (initial.length) socket.write(initial);
      if (head.length) peer.write(head);
      peer.pipe(socket);
      socket.pipe(peer);
      socket.on("close", () => peer.destroy());
      peer.on("close", () => socket.destroy());
      socket.on("error", () => peer.destroy());
      peer.on("error", () => socket.destroy());
    });
    upstream.on("response", (response) => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`); });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  })
  .listen(ports.proxy, addrs.proxy, () => {
    console.log(`proxy ${addrs.proxy}:${ports.proxy} -> ${addrs.bot}:${ports.web} from ${addrs.trustedPeer}`);
  });
