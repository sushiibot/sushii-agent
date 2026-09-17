# buzz CLI: block/buzz publishes only a Desktop app release (no CLI binary), so compile the `buzz`
# CLI from source. Built natively for the target platform (emulated under QEMU for arm64) rather than
# cross-compiled, because the rustls stack pulls aws-lc-sys, which is fiddly to cross-compile but
# builds cleanly in-arch. Slower, but robust. Pinned to a commit (bump BUZZ_REF).
FROM rust:1-bookworm AS buzz-build
ARG BUZZ_REF=be48ce98bd163899197b79a82ad5b2bcf0bc9b54
# cmake + perl: aws-lc-sys' build (pulled transitively via rustls' default aws-lc-rs feature).
# build-essential: C/C++ toolchain for the -sys crates (ring, secp256k1-sys, aws-lc-sys). No OpenSSL:
# reqwest is rustls-only.
RUN apt-get update && apt-get install -y --no-install-recommends cmake perl build-essential \
    && rm -rf /var/lib/apt/lists/*
# Shallow-fetch just the pinned commit (GitHub allows fetch-by-SHA), then build only buzz-cli.
RUN git init /src \
    && cd /src \
    && git remote add origin https://github.com/block/buzz.git \
    && git fetch --depth 1 origin "${BUZZ_REF}" \
    && git checkout FETCH_HEAD
WORKDIR /src
RUN cargo build --release -p buzz-cli --bin buzz \
    && cp target/release/buzz /usr/local/bin/buzz

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

# buzz CLI (compiled in the buzz-build stage) — drives the native buzz surface (src/surfaces/buzz).
COPY --from=buzz-build /usr/local/bin/buzz /usr/local/bin/buzz

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
