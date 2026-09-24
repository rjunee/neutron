#!/usr/bin/env bash
# Operator admission for shared Linux hosts. CI and Trident keep their own gates.
set -uo pipefail

run_shared_host_checks() (
  local check_root="$1" git_common_dir knob lock_status
  git_common_dir="$(git -C "$check_root" rev-parse --path-format=absolute --git-common-dir)" || {
    echo 'shared-host-check: REFUSED — checks require a Git repository.' >&2
    exit 2
  }
  # Every linked worktree resolves this existing directory. Lock its inode with
  # a read-only fd: no writable lock pathname can be rotated or truncated here.
  exec 9<"$git_common_dir" || exit 2
  flock -n -E 75 9
  lock_status=$?
  if [ "$lock_status" -eq 75 ]; then
    echo 'shared-host-check: BUSY — another admitted check is active; no checks started.' >&2
    exit 75
  elif [ "$lock_status" -ne 0 ]; then
    echo 'shared-host-check: REFUSED — admission lock could not be checked.' >&2
    exit 2
  fi
  cd "$check_root" || exit 2

  # A shard, planner, fixture root or fake Bun must never become full-suite proof.
  while IFS= read -r knob; do
    case "$knob" in
      NEUTRON_TEST_*|NEUTRON_BUN_BIN) unset "$knob" || exit 2 ;;
    esac
  done < <(compgen -A variable)
  export NEUTRON_TEST_JOBS=4 NEUTRON_TEST_CHUNK_SIZE=100
  echo 'shared-host-check: admitted; jobs=4 chunk-size=100; runner-default concurrency'
  bash scripts/ci/typecheck-all.sh || exit "$?"
  bash scripts/run-tests.sh
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [ "$#" -ne 0 ]; then
    echo 'Usage: bash scripts/check-shared-host.sh (no arguments)' >&2
    exit 2
  fi
  command -v flock >/dev/null || { echo 'shared-host-check: REFUSED — flock is required.' >&2; exit 2; }
  check_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 2
  run_shared_host_checks "$check_root"
fi
