#!/bin/sh
#
# uninstall.sh — remove a Neutron self-host install.
#
# Stops a running gateway, then removes what install.sh creates:
#
#   0. the launchd/systemd service + backup timer + the `neutron` CLI symlink
#   1. NEUTRON_HOME      data dir (auth, registry, AND the project database —
#                        the server opens $NEUTRON_HOME/project.db, so removing
#                        NEUTRON_HOME removes the database too)
#                        default $HOME/neutron/data
#   2. NEUTRON_SRC_DIR   code dir from the clone path
#                        default $HOME/neutron/core  (override with --dir)
#   3. the now-empty ~/neutron umbrella (only if nothing else remains under it)
#
# A custom NEUTRON_DB_PATH (a DB file you pinned OUTSIDE NEUTRON_HOME at install
# time) is removed as an extra target, along with its -wal/-shm sidecars.
#
# Every path is printed before anything is removed, and nothing is removed
# without either a terminal confirmation or an explicit --yes/-y. Each target is
# asserted to be a non-empty path under $HOME — the script refuses to remove "/"
# or $HOME itself.
#
# Running-checkout guard: uninstall is teardown ONLY and is NOT a prerequisite
# for install (install.sh is the single entry point for a fresh setup). When you
# run it from inside your own checkout (the documented location) with no .env
# pinning the code dir elsewhere, the resolved code dir IS the very checkout this
# script is running from. Deleting that would wipe your code out from under you
# (hit live during dogfood 2026-06-17). So a removal target that equals — or is
# an ancestor of — the directory uninstall.sh lives in / was launched from is
# REFUSED by default (the data dir is still removed); pass --remove-checkout to
# override and delete the checkout too.
#
# Flags:
#   --yes, -y          assume yes; skip the confirmation prompt (non-interactive)
#   --dir <path>       override the code directory (NEUTRON_SRC_DIR)
#   --remove-checkout  also remove the code dir even when it is the checkout this
#                      script is running from (off by default — see guard above)
#   --help, -h         show this help
#
# Environment:
#   NEUTRON_HOME       data directory (default $HOME/neutron/data)
#   NEUTRON_SRC_DIR    code directory  (default $HOME/neutron/core)
#   NEUTRON_DB_PATH    custom database file, if you set one at install time
#
# NEUTRON_HOME / NEUTRON_DB_PATH are also read from the checkout's .env (the same
# precedence install.sh uses: live env > .env > default), so a home or DB pinned
# only in .env is uninstalled too — uninstall targets the EXACT paths install
# created, never a stale default.
#
# POSIX sh — no bashisms.

set -eu

# Keep `cd` from echoing a CDPATH-resolved path when resolving the script dir.
unset CDPATH 2>/dev/null || true

DEFAULT_SRC_DIR=${NEUTRON_SRC_DIR:-$HOME/neutron/core}

ASSUME_YES=0
DIR_OVERRIDE=""
REMOVE_CHECKOUT=0

# ── UI theme (lighter twin of install.sh's) ──────────────────────────────────
# Same graceful-degradation contract: color only when stdout is a TTY (or the
# test-seam force), NO_COLOR unset, TERM not "dumb". With $FANCY=0 the color vars
# are empty and info()/warn()/die() emit the EXACT pre-theme 'neutron: …' bytes,
# so piped/CI/non-interactive uninstall output is byte-identical and free of
# escape-code garbage.
ESC=$(printf '\033')
FANCY=0
if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ] \
     && { [ -t 1 ] || [ "${NEUTRON_UI_FORCE_COLOR:-0}" = 1 ]; }; then
  FANCY=1
fi
if [ "$FANCY" = 1 ]; then
  C_RESET="${ESC}[0m"; C_BOLD="${ESC}[1m"; C_DIM="${ESC}[2m"
  C_BRAND="${ESC}[38;5;141m"
  C_WARN="${ESC}[38;5;214m"; C_ERR="${ESC}[38;5;203m"; C_MUTE="${ESC}[38;5;245m"
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_BRAND=''
  C_WARN=''; C_ERR=''; C_MUTE=''
fi
# Stop the background spinner subshell if one is running. Idempotent and
# defensive: uninstall.sh runs no spinner today, but mirroring install.sh's
# cleanup path means that if one is ever added it can never orphan past exit (a
# direct `kill -TERM` reaches the parent via the trap but not a spinner subshell).
# A no-op while SPIN_PID is empty.
SPIN_PID=''
stop_spinner() {
  [ -n "${SPIN_PID:-}" ] || return 0
  kill "$SPIN_PID" 2>/dev/null || true
  wait "$SPIN_PID" 2>/dev/null || true
  SPIN_PID=''
}
ui_cleanup() { stop_spinner; [ "$FANCY" = 1 ] && printf '%s' "$C_RESET" || true; }
# Split the signal traps from the EXIT trap. ui_cleanup RETURNS (does not exit),
# so a single `trap ui_cleanup EXIT INT TERM` would swallow SIGINT/SIGTERM: the
# handler runs, the script keeps going, and it exits 0 — losing cancellation and
# the conventional 130/143 codes. Especially dangerous for a destructive
# uninstaller. EXIT stays cleanup-only; the signal handlers clean up THEN re-exit
# with 128+signo.
trap ui_cleanup EXIT
trap 'ui_cleanup; exit 130' INT
trap 'ui_cleanup; exit 143' TERM

# Compact themed header — intentionally lighter than install.sh's full wordmark.
ui_uninstall_header() {
  [ "$FANCY" = 1 ] || return 0
  printf '\n  %s⚛ NEUTRON%s  %suninstall%s\n\n' "$C_BOLD$C_BRAND" "$C_RESET" "$C_MUTE" "$C_RESET"
}

info() { printf '%sneutron:%s %s\n' "$C_MUTE" "$C_RESET" "$*"; }
warn() { printf '%sneutron: WARNING:%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()  { printf '%sneutron: ERROR:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

# A set-but-empty HOME slips past `set -u`, after which the "$HOME"/* under-home
# glob in assert_safe_target degrades to /* — a catastrophic match. Refuse outright.
[ -n "${HOME:-}" ] || die "HOME is empty — refusing to resolve removal targets"

usage() {
  sed -n '2,/^$/p' "$0" 2>/dev/null | sed 's/^#\{0,1\} \{0,1\}//' || true
}

# >>> NEUTRON-SHARED-RESOLVERS v1 — keep this block byte-identical with the twin
#     script (install.sh ⇄ uninstall.sh). A parity test in
#     scripts/__tests__/install-uninstall.test.ts asserts the two copies match,
#     so install and uninstall always resolve the SAME data dir + DB file.
# Read KEY=value from a dotenv file the way Bun's .env loader sees it: skip
# comment / blank lines, take the LAST assignment, strip one surrounding pair of
# quotes, and expand `$HOME` / `${HOME}` (the one var the .env.example documents —
# Bun expands it; plain shell would not). Never execs the file, so a hostile
# .env cannot run code here. Prints nothing when the key is absent.
dotenv_get() {
  _file=${1:-}
  _key=$2
  [ -n "$_file" ] || return 0
  [ -f "$_file" ] || return 0
  _line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${_key}=" "$_file" 2>/dev/null | tail -n1)
  [ -n "$_line" ] || return 0
  _val=${_line#*=}
  case "$_val" in
    \"*\") _val=${_val#\"}; _val=${_val%\"} ;;
    \'*\') _val=${_val#\'}; _val=${_val%\'} ;;
  esac
  _val=$(printf '%s' "$_val" | sed -e "s|\${HOME}|$HOME|g" -e "s|\$HOME|$HOME|g")
  printf '%s\n' "$_val"
}

# Resolve the data directory the same way open/owner-identity.ts does:
# NEUTRON_HOME wins, then OWNER_HOME, then $HOME/neutron. An optional .env file
# is consulted AFTER the live environment (Bun does not let .env override an
# already-set variable), so a home pinned only in .env is honored too.
resolve_neutron_home() {
  _envfile=${1:-}
  if [ "${NEUTRON_HOME:-}" != "" ]; then
    printf '%s\n' "$NEUTRON_HOME"; return 0
  fi
  if [ "${OWNER_HOME:-}" != "" ]; then
    printf '%s\n' "$OWNER_HOME"; return 0
  fi
  _pin=$(dotenv_get "$_envfile" NEUTRON_HOME)
  [ "$_pin" = "" ] || { printf '%s\n' "$_pin"; return 0; }
  _pin=$(dotenv_get "$_envfile" OWNER_HOME)
  [ "$_pin" = "" ] || { printf '%s\n' "$_pin"; return 0; }
  printf '%s\n' "$HOME/neutron"
}

# Resolve the SQLite file the server opens (open/server.ts → resolveOpenDbPath):
# NEUTRON_DB_PATH wins (live env first, then a .env pin), else <home>/project.db.
# This MUST match the server so install migrates — and uninstall removes — the
# exact same DB file the server reads.
resolve_db_target() {
  _home=$1
  _envfile=${2:-}
  if [ "${NEUTRON_DB_PATH:-}" != "" ]; then
    printf '%s\n' "$NEUTRON_DB_PATH"; return 0
  fi
  _pin=$(dotenv_get "$_envfile" NEUTRON_DB_PATH)
  [ "$_pin" = "" ] || { printf '%s\n' "$_pin"; return 0; }
  printf '%s\n' "$_home/project.db"
}

# Resolve an in-place checkout directory the SAME way in both scripts, so install
# and uninstall agree on WHICH checkout they operate on. Precedence mirrors
# install.sh's original mode detection exactly:
#   1. an explicit --dir ($1) that ALREADY holds a checkout (open/server.ts) — and
#      only that: a --dir without a checkout is the caller's clone/removal target,
#      so we print nothing and let the caller fall back to it;
#   2. else the script's own directory ($2) when open/server.ts sits beside it;
#   3. else the current directory when it holds a checkout.
# Prints the resolved checkout path, or nothing when none is found (the caller
# then falls back to its default — clone target for install, $HOME/.neutron/src
# for uninstall). This is what lets `sh uninstall.sh` run from inside an in-place
# checkout target THAT checkout (its .env, its files) instead of the remote-
# install default, matching the dir install.sh resolved.
resolve_src_dir() {
  _override=${1:-}
  _scriptdir=${2:-}
  if [ "$_override" != "" ]; then
    [ -f "$_override/open/server.ts" ] && printf '%s\n' "$_override"
    return 0
  fi
  if [ "$_scriptdir" != "" ] && [ -f "$_scriptdir/open/server.ts" ]; then
    printf '%s\n' "$_scriptdir"; return 0
  fi
  if [ -f "open/server.ts" ]; then
    printf '%s\n' "$(pwd)"; return 0
  fi
  return 0
}
# <<< NEUTRON-SHARED-RESOLVERS v1

# Installer data-dir default — byte-identical intent to install.sh's copy. The
# shared resolve_neutron_home floors at the legacy flat $HOME/neutron; upgrade
# that floor to the nested $HOME/neutron/data so uninstall targets the SAME dir
# install created. An explicit pin to any other path is honored verbatim. (On a
# real uninstall .env already pins NEUTRON_HOME=$HOME/neutron/data, so this only
# matters when no .env is present — e.g. the remote-install neutral layout.)
resolve_install_home() {
  _h=$(resolve_neutron_home "${1:-}")
  [ "$_h" = "$HOME/neutron" ] && _h="$HOME/neutron/data"
  printf '%s\n' "$_h"
}

# Refuse to remove anything that is not a non-empty path strictly under $HOME.
# Returns 0 if the path is a safe removal target, 1 otherwise (caller skips it).
# Exits hard on the catastrophic targets ("/" and $HOME) so a misconfigured
# env can never blow away a home directory.
assert_safe_target() {
  _t=$1
  [ "$_t" != "" ] || return 1
  case "$_t" in
    /|//) die "refusing to remove the filesystem root ($_t)" ;;
  esac
  # The under-$HOME check below is a string prefix, so a `..` component lets a
  # target like $HOME/../../etc satisfy "$HOME"/* and then resolve OUTSIDE $HOME
  # at rm time. Reject any path that contains a `..` component before comparing.
  case "/$_t/" in
    */../*) die "refusing a target with a '..' path component ($_t)" ;;
  esac
  # Strip a single trailing slash for the exact-$HOME comparison.
  _norm=${_t%/}
  if [ "$_norm" = "$HOME" ] || [ "$_norm" = "${HOME%/}" ]; then
    die "refusing to remove \$HOME itself ($_t)"
  fi
  case "$_t/" in
    "$HOME"/*) return 0 ;;
    *) warn "skipping $_t — not under \$HOME"; return 1 ;;
  esac
}

# True (0) if $1 (a directory) is the checkout uninstall.sh is running from — or
# an ANCESTOR of it — so that removing $1 would delete the live checkout out from
# under the running process. $RUNNING_DIRS (computed once below, after arg parse)
# holds the PHYSICAL paths uninstall.sh lives in and/or was launched from. This
# is the verdict only; the caller decides whether to skip (default) or proceed
# (--remove-checkout). False (1) when RUNNING_DIRS is unknown or $1 cannot be
# canonicalized (e.g. a DB FILE, never a checkout dir — `cd` to it fails).
targets_running_checkout() {
  _cand=$1
  [ "${RUNNING_DIRS:-}" != "" ] || return 1
  _creal=$(cd "$_cand" 2>/dev/null && pwd -P) || _creal=""
  [ "$_creal" != "" ] || return 1
  _hit=1
  _oldifs=$IFS
  IFS='
'
  for _rd in $RUNNING_DIRS; do
    [ "$_rd" != "" ] || continue
    # Exact match, or $1 is an ancestor of a running dir (running dir lives under it).
    if [ "$_creal" = "$_rd" ]; then _hit=0; break; fi
    case "$_rd/" in
      "$_creal"/*) _hit=0; break ;;
    esac
  done
  IFS=$_oldifs
  return $_hit
}

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  if [ -t 0 ]; then
    printf 'neutron: remove the paths above? [y/N] '
    read -r _ans
  elif [ -e /dev/tty ]; then
    printf 'neutron: remove the paths above? [y/N] ' > /dev/tty
    read -r _ans < /dev/tty
  else
    die "non-interactive (no terminal) and no --yes/-y given — refusing to remove anything"
  fi
  case "$_ans" in
    y|Y|yes|YES) return 0 ;;
    *) info "aborted; nothing removed"; exit 0 ;;
  esac
}

# Resolve a process's current working directory, portably. Linux exposes it as
# the /proc/<pid>/cwd symlink; macOS (no /proc) needs `lsof`. Prints the cwd and
# returns 0 on success; prints nothing and returns 1 when it cannot be resolved.
proc_cwd() {
  _pid=$1
  if [ -e "/proc/$_pid/cwd" ]; then
    _c=$(readlink "/proc/$_pid/cwd" 2>/dev/null || true)
    [ "$_c" != "" ] && { printf '%s\n' "$_c"; return 0; }
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    # -Fn → field output; the cwd path is the `n`-prefixed line of the cwd fd.
    _c=$(lsof -a -p "$_pid" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')
    [ "$_c" != "" ] && { printf '%s\n' "$_c"; return 0; }
  fi
  return 1
}

# Stop a running gateway: prefer the pidfile install.sh --start writes, then a
# cwd-scoped sweep that matches Neutron's OWN server entrypoint and confirms the
# process belongs to THIS checkout — never a bystander gateway from another
# checkout, and never a non-Neutron process.
stop_gateway() {
  _home=$1
  _src=${2:-}
  # A process's cwd (from /proc or lsof) is PHYSICAL — every symlink resolved
  # (/tmp→/private/tmp on macOS, a symlinked $HOME or /var on Linux). Comparing a
  # raw $_src against it would fail to match and let OUR OWN gateway survive — the
  # very bug this guards. Canonicalize $_src to its physical path once, up front,
  # so the cwd comparison below is physical-vs-physical. Falls back to the raw
  # value if $_src cannot be entered (e.g. already partially removed).
  _src_real=""
  if [ "$_src" != "" ]; then
    _src_real=$(cd "$_src" 2>/dev/null && pwd -P) || _src_real=""
    [ "$_src_real" != "" ] || _src_real=$_src
  fi
  _pidfile="$_home/neutron.pid"
  if [ -f "$_pidfile" ]; then
    _pid=$(cat "$_pidfile" 2>/dev/null || true)
    if [ "$_pid" != "" ] && kill -0 "$_pid" 2>/dev/null; then
      # A stale pidfile can name a PID the OS has since recycled onto an
      # unrelated same-user process. Confirm the live process is actually
      # Neutron's gateway (its cmdline carries the open/server.ts entrypoint)
      # before sending any signal; a non-matching PID is treated as stale.
      _cmd=$(ps -o command= -p "$_pid" 2>/dev/null || true)
      case "$_cmd" in
        *open/server.ts*)
          info "stopping the gateway (pid $_pid)"
          kill "$_pid" 2>/dev/null || true
          # give it a moment, then force if still alive
          _n=0
          while [ "$_n" -lt 10 ] && kill -0 "$_pid" 2>/dev/null; do
            sleep 1
            _n=$((_n + 1))
          done
          kill -0 "$_pid" 2>/dev/null && kill -9 "$_pid" 2>/dev/null || true
          ;;
        *)
          warn "pid $_pid (from $_pidfile) is not a Neutron gateway — treating as a stale pidfile, not killing it"
          ;;
      esac
    fi
    rm -f "$_pidfile"
  fi
  # Fallback (no/stale pidfile, or a gateway someone started by hand). The
  # gateway runs as the RELATIVE `bun run open/server.ts` — install.sh cd's into
  # the checkout before launching, so the running process's cmdline NEVER
  # contains the absolute $_src prefix. Matching `$_src/open/server.ts` therefore
  # matches NOTHING and would let the gateway keep running against files we are
  # about to delete. Instead, enumerate every `bun run open/server.ts` process by
  # the token that ACTUALLY appears in its cmdline, then scope by WORKING
  # DIRECTORY: a process whose cwd is THIS checkout ($_src) is unambiguously our
  # gateway and is stopped; a gateway for a DIFFERENT checkout under the same
  # user has a different cwd and is left running; nothing that isn't a Neutron
  # entrypoint matches the pattern at all.
  if command -v pgrep >/dev/null 2>&1; then
    for _gpid in $(pgrep -f 'bun run open/server.ts' 2>/dev/null || true); do
      # Defense in depth: confirm the cmdline carries the entrypoint token (a
      # recycled PID could no longer be the gateway pgrep matched a moment ago).
      _gcmd=$(ps -o command= -p "$_gpid" 2>/dev/null || true)
      case "$_gcmd" in
        *open/server.ts*) : ;;
        *) continue ;;
      esac
      if [ "$_src" = "" ]; then
        # No checkout to scope by — stop every matched Neutron gateway. This is
        # the only branch that kills without a cwd match, and it is reachable
        # only when the src dir is genuinely unknown (preserves the
        # no-bystander guarantee: a non-Neutron process never matched above).
        info "stopping the gateway (pid $_gpid)"
        kill "$_gpid" 2>/dev/null || true
        continue
      fi
      _gcwd=$(proc_cwd "$_gpid" || true)
      if [ "$_gcwd" = "" ]; then
        # cwd undeterminable AND we have a checkout: we cannot prove this PID is
        # ours, so leave it. THIS checkout's gateway is handled by the pidfile
        # branch above (install.sh records the entrypoint PID directly).
        continue
      fi
      # Compare the process's PHYSICAL cwd against the PHYSICAL checkout path.
      case "$_gcwd/" in
        "$_src_real"/* | "${_src_real%/}"/*)
          info "stopping the gateway (pid $_gpid, cwd $_gcwd)"
          kill "$_gpid" 2>/dev/null || true
          ;;
        *) : ;;   # a DIFFERENT checkout's gateway — leave it running
      esac
    done
  elif command -v pkill >/dev/null 2>&1 && [ "$_src" = "" ]; then
    # No pgrep available and no checkout to scope by: last-resort broad match,
    # reachable ONLY when $_src is unknown (preserves the no-bystander guarantee
    # — we never broad-pkill while a specific checkout is in play).
    pkill -f 'bun run open/server.ts' 2>/dev/null || true
  fi
}

# Stop + remove the launchd/systemd service, the backup timer, and the `neutron`
# CLI symlink. Best-effort: each helper is only invoked if it still exists in the
# checkout (it is about to be deleted), and failures never abort the uninstall.
teardown_services() {
  _src=$1
  _home=$2
  for _pair in neutron-service.sh:uninstall neutron-backup.sh:uninstall-timer; do
    _f=${_pair%%:*}
    _sub=${_pair#*:}
    if [ -f "$_src/$_f" ]; then
      NEUTRON_SERVICE_CODE_DIR="$_src" NEUTRON_HOME="$_home" sh "$_src/$_f" "$_sub" >/dev/null 2>&1 || true
    fi
  done
  # Remove the neutron CLI symlink only when it points into THIS checkout.
  _cli="$HOME/.local/bin/neutron"
  if [ -L "$_cli" ]; then
    _tgt=$(readlink "$_cli" 2>/dev/null || true)
    case "$_tgt" in
      "$_src"/*) rm -f "$_cli" && info "removed $_cli" || true ;;
    esac
  fi
}

# Remove the ~/neutron umbrella IFF it is now empty (both core/ + data/ gone).
# Never force — a non-empty umbrella (custom files, a sibling install) survives.
remove_empty_umbrella() {
  _u="$HOME/neutron"
  if [ -d "$_u" ] && [ -z "$(ls -A "$_u" 2>/dev/null || true)" ]; then
    rmdir "$_u" 2>/dev/null && info "removed empty $_u" || true
  fi
}

# ── parse args ───────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --dir) DIR_OVERRIDE=${2:-}; [ "$DIR_OVERRIDE" != "" ] || die "--dir needs a value"; shift 2 ;;
    --dir=*) DIR_OVERRIDE=${1#--dir=}; shift ;;
    --remove-checkout) REMOVE_CHECKOUT=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# Resolve WHICH checkout to uninstall, mirroring install.sh's in-place detection
# (shared resolve_src_dir). On the documented dogfood cleanup path —
# `git clone <repo>; cd <repo>; sh install.sh`, then `./uninstall.sh` from the
# same dir — install.sh installed in place from THIS checkout, so uninstall must
# target THIS checkout too: its .env, its NEUTRON_HOME/NEUTRON_DB_PATH pins, and
# its own directory. Without this, uninstall blindly defaulted to the remote-
# install location ($HOME/.neutron/src), read the wrong (or no) .env, and could
# orphan .env-pinned data AND leave the real checkout on disk. Only when no in-
# place checkout is detected (the genuine curl | sh remote layout) do we fall
# back — to an explicit --dir if given (always honored as the removal target,
# even if it no longer holds a checkout), else $HOME/.neutron/src.
SCRIPT_DIR=""
case "$0" in
  */*) SCRIPT_DIR=$(dirname -- "$0"); SCRIPT_DIR=$(cd -- "$SCRIPT_DIR" 2>/dev/null && pwd || true) ;;
esac
SRC_DIR=$(resolve_src_dir "$DIR_OVERRIDE" "$SCRIPT_DIR")
[ "$SRC_DIR" != "" ] || SRC_DIR=${DIR_OVERRIDE:-$DEFAULT_SRC_DIR}

# The directories uninstall.sh is "running from": the dir it physically lives in
# (when $0 lets us find it — empty for a bare `sh uninstall.sh` whose $0 carries
# no slash) AND the current working directory. On the documented dogfood path a
# user cd's into their clone and runs `sh uninstall.sh`, so the cwd is the live
# checkout even when $0 gives no script dir. A removal target that equals — or is
# an ancestor of — either of these is the checkout the user is standing in;
# deleting it would wipe the code out from under them (2026-06-17 incident:
# SRC_DIR resolved to the checkout via the cwd branch of resolve_src_dir, with no
# .env pin redirecting the code dir, and uninstall removed it). targets_running_
# checkout() guards against this; --remove-checkout opts back in. Both paths are
# canonicalized to their PHYSICAL form (pwd -P) so the comparison is symlink-safe.
RUNNING_DIRS=""
if [ "$SCRIPT_DIR" != "" ]; then
  _sd=$(cd "$SCRIPT_DIR" 2>/dev/null && pwd -P) || _sd=""
  [ "$_sd" != "" ] && RUNNING_DIRS="$_sd"
fi
_cwd=$(pwd -P 2>/dev/null || true)
if [ "$_cwd" != "" ]; then
  RUNNING_DIRS="${RUNNING_DIRS:+$RUNNING_DIRS
}$_cwd"
fi

# Resolve the data dir + DB exactly as install.sh + the server do, consulting the
# checkout's .env (the SAME dotenv_get precedence: live env > .env > default).
# Without this, a user who pinned NEUTRON_HOME / NEUTRON_DB_PATH in .env would
# uninstall the DEFAULT paths, orphan their real data, and see a misleading
# "nothing to remove". The .env lives in the code dir, so SRC_DIR/.env is it.
ENVFILE="$SRC_DIR/.env"
NEUTRON_HOME_RESOLVED=$(resolve_install_home "$ENVFILE")

# Database location: the default DB lives at $NEUTRON_HOME/project.db (per
# open/server.ts) and is removed when NEUTRON_HOME is removed — no separate
# target needed. Only a DB pinned OUTSIDE NEUTRON_HOME (via NEUTRON_DB_PATH in
# live env or .env) is an extra target. Resolve it the same way the server does,
# then keep it ONLY if it falls outside the home dir we are already removing.
DB_RESOLVED=$(resolve_db_target "$NEUTRON_HOME_RESOLVED" "$ENVFILE")
DB_TARGET=""
case "$DB_RESOLVED/" in
  "$NEUTRON_HOME_RESOLVED"/*) : ;;     # under NEUTRON_HOME — removed with it
  "${NEUTRON_HOME_RESOLVED%/}"/*) : ;; # ditto, tolerating a trailing slash
  *) DB_TARGET=$DB_RESOLVED ;;          # pinned outside home — an extra target
esac

# Test seam (harness only): print the resolved code dir + data dir + DB target,
# then exit BEFORE collecting or removing anything. Lets the unit test assert
# uninstall's in-place detection + .env resolution agree with install.sh, with
# no disk mutation.
if [ "${NEUTRON_UNINSTALL_PRINT_PLAN:-}" = "1" ]; then
  printf 'src=%s\n' "$SRC_DIR"
  printf 'home=%s\n' "$NEUTRON_HOME_RESOLVED"
  printf 'db=%s\n' "$DB_RESOLVED"
  exit 0
fi

ui_uninstall_header

# ── collect the real removal targets ─────────────────────────────────────────
# A target that is the running checkout (or an ancestor of it) is REFUSED by
# default — removing it would delete the code uninstall.sh is executing from.
# --remove-checkout flips this: the target is kept, with a loud confirmation
# line. The data dir is removed either way (it is a separate target).
TARGETS=""
SKIPPED_CHECKOUT=""
REMOVING_CHECKOUT=""
for candidate in "$NEUTRON_HOME_RESOLVED" "$DB_TARGET" "$SRC_DIR"; do
  [ "$candidate" != "" ] || continue
  [ -e "$candidate" ] || continue
  if targets_running_checkout "$candidate"; then
    if [ "$REMOVE_CHECKOUT" = 1 ]; then
      REMOVING_CHECKOUT=$candidate
      # fall through — explicit opt-in to delete the running checkout
    else
      SKIPPED_CHECKOUT=$candidate
      warn "refusing to delete the checkout uninstall.sh is running from: $candidate"
      warn "  pass --remove-checkout to override (the data dir is still removed)"
      continue
    fi
  fi
  if assert_safe_target "$candidate"; then
    TARGETS="$TARGETS$candidate
"
  fi
done

if [ "$TARGETS" = "" ]; then
  if [ "$SKIPPED_CHECKOUT" != "" ]; then
    info "left the running checkout in place ($SKIPPED_CHECKOUT); nothing else to remove"
    info "  pass --remove-checkout to also remove the checkout itself"
  else
    info "nothing to remove — no Neutron data, database, or code directory found"
  fi
  # Still tear down any installed service/timer/CLI + stop a stray gateway.
  teardown_services "$SRC_DIR" "$NEUTRON_HOME_RESOLVED"
  stop_gateway "$NEUTRON_HOME_RESOLVED" "$SRC_DIR"
  exit 0
fi

info "the following paths will be removed:"
printf '%s' "$TARGETS" | while IFS= read -r p; do
  [ "$p" != "" ] && printf '  %s%s%s\n' "$C_DIM" "$p" "$C_RESET"
done
if [ "$REMOVING_CHECKOUT" != "" ]; then
  warn "--remove-checkout: this WILL delete the checkout uninstall.sh is running from: $REMOVING_CHECKOUT"
fi

confirm

# Tear down the service/backup timer/CLI, then stop the gateway BEFORE deleting
# its data/code out from under it. teardown_services runs first so it can still
# read the helper scripts in the checkout we are about to remove.
teardown_services "$SRC_DIR" "$NEUTRON_HOME_RESOLVED"
stop_gateway "$NEUTRON_HOME_RESOLVED" "$SRC_DIR"

# Remove each target, re-asserting safety immediately before the rm.
printf '%s' "$TARGETS" | while IFS= read -r p; do
  [ "$p" != "" ] || continue
  if assert_safe_target "$p"; then
    info "removing $p"
    rm -rf "$p"
  fi
done

# Sidecar database files (write-ahead log / shared-memory) next to a custom file
# pinned outside NEUTRON_HOME. Sidecars beside the default in-home DB are removed
# with NEUTRON_HOME itself; only the outside-home DB_TARGET needs them cleared here.
if [ "$DB_TARGET" != "" ]; then
  for sidecar in "$DB_TARGET-shm" "$DB_TARGET-wal"; do
    [ -e "$sidecar" ] || continue
    if assert_safe_target "$sidecar"; then
      info "removing $sidecar"
      rm -f "$sidecar"
    fi
  done
fi

# Clean up the now-empty ~/neutron umbrella (both core/ + data/ removed).
remove_empty_umbrella

info "uninstall complete."
