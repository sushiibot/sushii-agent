FROM oven/bun:1

# openssh-client: ssh-agent/ssh-add/ssh for wiki-sync's git push auth (docker-entrypoint.sh) and
# git itself, for simple-git's clone/fetch/push. Neither ships in the base image.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client git \
    && rm -rf /var/lib/apt/lists/*

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
