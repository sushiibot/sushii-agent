#!/bin/sh
set -eu

# /data is a bind mount, so HOME and the user-space install dirs may not exist on first start.
# mkdir -p succeeds on existing dirs even when they are root-owned, hence the -w check.
if ! mkdir -p "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.cache" 2>/dev/null \
  || [ ! -w "$HOME" ]; then
  echo "workspace: cannot write $HOME; /data must be writable by uid $(id -u) (chown 1000:1000 the volume)" >&2
  exit 1
fi

exec "$@"
