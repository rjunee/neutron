#!/usr/bin/env bash
# Operator admission for shared Linux hosts. CI and Trident keep their own gates.
set -uo pipefail

run_shared_host_checks() (
  local check_root="$1" git_common_dir knob lock_status local_main remote_main remote_sha remote_ref
  local authority_repo authority_url local_candidate bare hop diff_bytes
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

  # The stale-prose guard diffs against origin/main. A stale tracking ref can
  # turn a small branch into a multi-megabyte diff and fail its bounded reader
  # only after the expensive gates have started. Verify the remote's exact main
  # tip without changing refs; operators can fetch explicitly when it differs.
  local_main="$(git rev-parse --verify --quiet 'refs/remotes/origin/main^{commit}')" || {
    echo 'shared-host-check: REFUSED — origin/main is missing. Fetch origin main, then rerun.' >&2
    exit 2
  }
  # A worktree's origin can itself be a local clone. Its main may lag behind
  # its own origin/main, so following only the first URL would bless a stale
  # base. Support that one measured local-clone hop; refuse deeper chains.
  authority_repo="$check_root"
  for ((hop = 0; hop < 2; hop++)); do
    authority_url="$(git -C "$authority_repo" remote get-url origin 2>/dev/null)" || {
      echo 'shared-host-check: REFUSED — a local source clone has no origin to verify.' >&2
      exit 2
    }
    case "$authority_url" in
      file://localhost/*) local_candidate="${authority_url#file://localhost}" ;;
      file:///*) local_candidate="${authority_url#file://}" ;;
      file://*)
        echo 'shared-host-check: REFUSED — unsupported file origin host.' >&2
        exit 2 ;;
      /*|./*|../*) local_candidate="$authority_url" ;;
      *)
        if [ -d "$authority_repo/$authority_url" ]; then local_candidate="$authority_url"
        else break
        fi ;;
    esac
    if [[ "$local_candidate" != /* ]]; then local_candidate="$authority_repo/$local_candidate"; fi
    local_candidate="$(cd "$local_candidate" 2>/dev/null && pwd -P)" || {
      echo 'shared-host-check: REFUSED — local origin path is unavailable.' >&2
      exit 2
    }
    git -C "$local_candidate" rev-parse --git-dir >/dev/null 2>&1 || {
      echo 'shared-host-check: REFUSED — local origin is not a Git repository.' >&2
      exit 2
    }
    bare="$(git -C "$local_candidate" rev-parse --is-bare-repository)" || exit 2
    if [ "$bare" = true ] && ! git -C "$local_candidate" remote get-url origin >/dev/null 2>&1; then
      authority_url="$local_candidate"
      break
    fi
    authority_repo="$local_candidate"
  done
  if [ "$hop" -eq 2 ]; then
    echo 'shared-host-check: REFUSED — origin has more than one local source clone; verify its upstream manually.' >&2
    exit 2
  fi
  remote_main="$(timeout 20s git ls-remote --exit-code "$authority_url" refs/heads/main)" || {
    echo 'shared-host-check: REFUSED — cannot verify origin main (remote unavailable or timed out). Check access, then rerun.' >&2
    exit 2
  }
  IFS=$'\t' read -r remote_sha remote_ref <<< "$remote_main"
  if [[ ! "$remote_sha" =~ ^([[:xdigit:]]{40}|[[:xdigit:]]{64})$ || "$remote_ref" != refs/heads/main ]]; then
    echo 'shared-host-check: REFUSED — origin main returned an invalid ref; no checks started.' >&2
    exit 2
  fi
  if [ "$local_main" != "$remote_sha" ]; then
    echo "shared-host-check: REFUSED — origin/main is stale ($local_main; remote main is $remote_sha). Fetch origin main, then rerun." >&2
    exit 2
  fi
  # The guard's spawnSync reader has a 1 MiB output limit. A legitimately large
  # branch must be refused explicitly before the suite, not fail there as though
  # stale prose had been proven. Leave headroom for process output framing.
  diff_bytes="$(git diff --unified=0 --no-renames origin/main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs' '*.md' | wc -c)" || {
    echo 'shared-host-check: REFUSED — could not size the stale-prose diff.' >&2
    exit 2
  }
  if (( diff_bytes >= 1000000 )); then
    echo "shared-host-check: REFUSED — stale-prose diff is $diff_bytes bytes, beyond its 1 MiB reader limit. Rebase or split the branch, then rerun." >&2
    exit 2
  fi

  # A shard, planner, fixture root or fake Bun must never become full-suite proof.
  while IFS= read -r knob; do
    case "$knob" in
      NEUTRON_TEST_*|NEUTRON_BUN_BIN|STALE_PROSE_BASE_SHA|STALE_PROSE_HEAD_SHA) unset "$knob" || exit 2 ;;
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
