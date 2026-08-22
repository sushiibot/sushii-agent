#!/bin/sh
set -eu

# wiki-sync's git push credential: loaded into ssh-agent here, before the app process starts,
# so the key never exists as a file the app's own filesystem tools (Pi's read/grep/find, which
# have no sandbox) could open. Only the agent socket is visible to the app afterward.
if [ -n "${WIKI_SYNC_SSH_PRIVATE_KEY:-}" ]; then
  eval "$(ssh-agent -s)"
  printf '%s\n' "$WIKI_SYNC_SSH_PRIVATE_KEY" | ssh-add - >/dev/null
  unset WIKI_SYNC_SSH_PRIVATE_KEY
  export SSH_AUTH_SOCK
fi

exec "$@"
