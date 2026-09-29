#!/bin/sh
set -eu

# /data is a bind mount, so HOME and the user-space install dirs may not exist on first start.
if ! mkdir -p "$HOME/.bun/bin" "$HOME/.local/bin" "$HOME/.npm-global/bin" "$HOME/.cache" 2>/dev/null; then
  echo "workspace: cannot create $HOME; /data must be writable by uid $(id -u) (chown 1000:1000 the volume)" >&2
  exit 1
fi

exec "$@"
