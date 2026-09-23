FROM oven/bun:1

# openssh-client: ssh-agent/ssh-add/ssh for wiki-sync's git push auth (docker-entrypoint.sh) and
# git itself, for simple-git's clone/fetch/push. Neither ships in the base image.
# poppler-utils: pdftotext/pdftoppm for wiki-sync PDF attachment handling.
# ripgrep: targeted search over the synced wiki for the search_wiki agent tool (src/modules/wiki-sync/search.ts).
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client git curl poppler-utils ripgrep \
    && rm -rf /var/lib/apt/lists/*

# lychee: link checker wiki-sync's commit_and_push tool runs before every commit to catch dead
# relative wiki links (see src/modules/wiki-sync/linkCheck.ts) -- a static binary, not an npm
# package, so it's fetched here rather than through bun install. TARGETARCH is set automatically
# by Docker buildx; mapped to lychee's own arch-naming since they don't match Docker's.
ARG LYCHEE_VERSION=0.24.2
ARG TARGETARCH
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) LYCHEE_ARCH=x86_64-unknown-linux-gnu ;; \
      arm64) LYCHEE_ARCH=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/lycheeverse/lychee/releases/download/lychee-v${LYCHEE_VERSION}/lychee-${LYCHEE_ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=1 "lychee-${LYCHEE_ARCH}/lychee"

# gh: the GitHub CLI, so a cloud-runner coding agent can open PRs itself (git push + gh pr create),
# authenticated by the per-task GH_TOKEN the runner injects into its shell. Static binary, same
# TARGETARCH fetch pattern as lychee.
ARG GH_VERSION=2.63.2
RUN set -eu; \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin --strip-components=2 "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"

# Headless browser for runner agents: Debian's chromium (built for both amd64 and arm64, unlike
# Chrome for Testing) driven by the agent-browser CLI. Static binary + its version-matched skill
# docs taken from the npm tarball, same TARGETARCH pattern as above.
ARG AGENT_BROWSER_VERSION=0.38.1
RUN set -eu; \
    apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH}" in \
      amd64) AB_ARCH=linux-x64 ;; \
      arm64) AB_ARCH=linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /opt/agent-browser; \
    curl -fsSL "https://registry.npmjs.org/agent-browser/-/agent-browser-${AGENT_BROWSER_VERSION}.tgz" \
      | tar -xz -C /opt/agent-browser --strip-components=1 "package/bin/agent-browser-${AB_ARCH}" package/skill-data; \
    chmod 755 "/opt/agent-browser/bin/agent-browser-${AB_ARCH}"; \
    ln -s "/opt/agent-browser/bin/agent-browser-${AB_ARCH}" /usr/local/bin/agent-browser
# Root in a container needs --no-sandbox; Docker's 64MB /dev/shm crashes Chromium without the shm flag.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_SKILLS_DIR=/opt/agent-browser/skill-data \
    AGENT_BROWSER_ARGS="--no-sandbox,--disable-dev-shm-usage"

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY . .

RUN mkdir -p /data
RUN chmod +x docker-entrypoint.sh

# Documentation only — mirrors the MCP_BRIDGE_PORT default; override that env var and this drifts.
EXPOSE 8787

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "src/index.ts"]
