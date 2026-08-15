FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

COPY . .

RUN mkdir -p /data

# Documentation only — mirrors the MCP_BRIDGE_PORT default; override that env var and this drifts.
EXPOSE 8787

CMD ["bun", "src/index.ts"]
