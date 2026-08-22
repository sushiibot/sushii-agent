#!/bin/sh
set -eu

# wiki-sync's git push credential: loaded into ssh-agent here, before the app process starts,
# so the key never exists as a file the app's own filesystem tools (Pi's read/grep/find, which
# have no sandbox) could open. Only the agent socket is visible to the app afterward.
#
# Delivered base64-encoded (WIKI_SYNC_SSH_PRIVATE_KEY_B64) because the raw key is multi-line
# PEM content -- ansible renders this into a YAML env list entry, where an embedded literal
# newline breaks parsing.
if [ -n "${WIKI_SYNC_SSH_PRIVATE_KEY_B64:-}" ]; then
  eval "$(ssh-agent -s)"
  echo "$WIKI_SYNC_SSH_PRIVATE_KEY_B64" | base64 -d | ssh-add - >/dev/null
  unset WIKI_SYNC_SSH_PRIVATE_KEY_B64
  export SSH_AUTH_SOCK
fi

exec "$@"
