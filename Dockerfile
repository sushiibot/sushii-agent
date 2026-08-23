FROM oven/bun:1

# openssh-client: ssh-agent/ssh-add/ssh for wiki-sync's git push auth (docker-entrypoint.sh) and
# git itself, for simple-git's clone/fetch/push. Neither ships in the base image.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client git curl \
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
