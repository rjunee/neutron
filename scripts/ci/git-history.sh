#!/usr/bin/env bash
# Shared probe for CI guards. Unknown is exit 2 (cannot evaluate), never false.
# Source this file; callers must propagate failure before fetching or diffing.
read_shallowness() {
  local answer
  if ! answer="$(git -C "$ROOT" rev-parse --is-shallow-repository 2>/dev/null)"; then
    echo "git-history: checkout shallowness UNKNOWN; cannot evaluate history." >&2
    return 2
  fi
  case "$answer" in
    true | false) printf '%s\n' "$answer" ;;
    *) echo "git-history: checkout shallowness UNKNOWN; unexpected probe answer." >&2; return 2 ;;
  esac
}
