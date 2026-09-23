#!/usr/bin/env bash
set -uo pipefail
# Lock the named ref before checking its type: --no-deref alone would replace
# a newly installed symref. Neither HEAD nor a foreign branch may be changed.
repo=$1 target_ref=$2 candidate=$3 expected=$4
exchange=$(mktemp -d) || exit 1
trap 'rm -f "$exchange/request" "$exchange/response"; rmdir "$exchange"' EXIT
mkfifo "$exchange/request" "$exchange/response" || exit 1
git -C "$repo" update-ref -m 'trident: recover builder commit' --stdin <"$exchange/request" >"$exchange/response" &
update_pid=$!
exec 3>"$exchange/request"
exec 4<"$exchange/response"
printf 'start\noption no-deref\nupdate %s %s %s\nprepare\n' "$target_ref" "$candidate" "$expected" >&3
if ! IFS= read -r response <&4 || [ "$response" != 'start: ok' ] ||
   ! IFS= read -r response <&4 || [ "$response" != 'prepare: ok' ]; then
  exec 3>&- 4<&-
  wait "$update_pid"
  exit 1
fi
ref_kind=$(git -C "$repo" symbolic-ref -q "$target_ref")
ref_exit=$?
if [ "$ref_exit" -ne 1 ] || [ -n "$ref_kind" ]; then
  printf 'abort\n' >&3
  exec 3>&-
  IFS= read -r response <&4
  exec 4<&-
  wait "$update_pid"
  exit 1
fi
printf 'commit\n' >&3
exec 3>&-
IFS= read -r response <&4
exec 4<&-
wait "$update_pid" || exit 1
[ "$response" = 'commit: ok' ]
