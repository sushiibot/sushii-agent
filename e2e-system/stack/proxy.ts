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
  .listen(ports.proxy, addrs.proxy, () => {
    console.log(`proxy ${addrs.proxy}:${ports.proxy} -> ${addrs.bot}:${ports.web} from ${addrs.trustedPeer}`);
  });
