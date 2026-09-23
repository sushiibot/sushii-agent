#!/bin/sh
# Runs inside the built image: agent-browser drives Debian chromium against a localhost dev server
# and the open web. Guards the browser layer, since the deploy host is arm64.
set -eu
mkdir -p /tmp/smoke-site
echo '<html><title>smoke ok</title><body><button>Go</button></body></html>' > /tmp/smoke-site/index.html
(cd /tmp/smoke-site && bun -e 'Bun.serve({ port: 5173, fetch: () => new Response(Bun.file("index.html")) })' &)
sleep 1
export AGENT_BROWSER_SESSION=smoke
agent-browser --version
agent-browser skills get core >/dev/null
agent-browser open http://localhost:5173
test "$(agent-browser get title)" = "smoke ok"
agent-browser snapshot -i | grep -q 'button "Go"'
agent-browser open https://example.com
test "$(agent-browser get title)" = "Example Domain"
agent-browser close
echo "browser smoke passed"
