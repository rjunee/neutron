#!/bin/sh
#
# install.sh — Neutron self-host installer.
#
# Neutron is a self-hosted agent harness for Claude Code: it orchestrates your
# own Claude Code sessions and wraps them with persistent memory, projects,
# scheduled/autonomous jobs, and reminders. Primary interface is the bundled web
# app (mobile app too); Telegram is an optional add-on. Backed by your own Claude
# subscription. This script gets a fresh machine from zero to a running gateway.
#
# Two ways to run it:
#
#   1. Straight from the public repo (nothing checked out yet):
#        curl -fsSL https://raw.githubusercontent.com/rjunee/neutron/main/install.sh | sh -s -- --yes
#      It clones the repo into a code directory (NEUTRON_SRC_DIR, default
#      $HOME/.neutron/src), then installs in place.
#
#   2. From inside an existing checkout (dogfooding before the public repo
#      exists, or after you cloned manually):
#        sh install.sh
#      It detects open/server.ts next to itself and installs in place — no clone.
#
# What "install" does, in the resolved source directory:
#   - verify prerequisites (bun required; git required for the clone path;
#     the claude CLI is optional and only warned about)
#   - bun install
#   - copy .env.example to .env (only if .env does not already exist)
#   - bun run migrate <db-path>  (the exact DB the server opens; the server does
#     NOT self-migrate on boot. The runner also defaults to this same path when
#     called with no arg, so a bare `bun run migrate` works too.)
#   - install a boot+crash supervisor service (launchd/systemd) + the `neutron` CLI
#   - schedule a deterministic git backup of the data dir
#   - AUTO-START the server and print the working chat URL
#
# Folder layout: a single ~/neutron umbrella holds both halves —
#   CODE  → ~/neutron/core   (NEUTRON_SRC_DIR; the cloned engine)
#   DATA  → ~/neutron/data   (NEUTRON_HOME; auth, registry, the project DB —
#                             the directory the git backup protects)
# Both are overridable (NEUTRON_SRC_DIR / NEUTRON_HOME / --dir) but default to
# this. An older FLAT install (~/neutron/project.db) is migrated into ~/neutron/data
# automatically.
#
# Flags:
#   --no-start     do NOT auto-start the server (default: start + print URL)
#   --no-service   do NOT install the launchd/systemd boot+crash service
#   --no-gbrain    do NOT install the GBrain memory binary (memory degrades to
#                  entity pages on disk — no knowledge-graph / semantic recall)
#   --no-backup    do NOT schedule the git data-backup timer
#   --no-open      do NOT open the chat URL in a browser on macOS
#   --start        accepted for back-compat (auto-start is now the default)
#   --yes, -y      assume yes; non-interactive (REQUIRED for the curl | sh path)
#   --dir <path>   override the source/code directory (NEUTRON_SRC_DIR)
#   --backup-remote <url>  offsite git remote for data backups; persisted to .env
#                  and wired into the backup timer (also via NEUTRON_BACKUP_REMOTE)
#   --help, -h     show this help
#
# Environment:
#   NEUTRON_REPO       git URL to clone (default https://github.com/rjunee/neutron.git)
#   NEUTRON_SRC_DIR    code directory for the clone path (default $HOME/neutron/core)
#   NEUTRON_HOME       data directory (default $HOME/neutron/data)
#   NEUTRON_PORT       HTTP port the server binds + the printed URL uses (default 7800)
#   NEUTRON_GBRAIN_REF       source ref for the GBrain memory binary
#                            (default github:garrytan/gbrain; installed via bun install -g)
#   NEUTRON_GBRAIN_INSTALL_CMD  override the gbrain install command entirely (test seam)
#   NEUTRON_BACKUP_REMOTE    git remote for offsite backup pushes (default: local-only)
#   NEUTRON_BACKUP_INTERVAL  seconds between backups (default 43200 = 12h)
#
# POSIX sh — no bashisms; runs under /bin/sh when piped from curl.

set -eu

# Keep `cd` from echoing a CDPATH-resolved path when resolving the script dir.
unset CDPATH 2>/dev/null || true

# ── defaults ─────────────────────────────────────────────────────────────────
NEUTRON_REPO=${NEUTRON_REPO:-https://github.com/rjunee/neutron.git}
DEFAULT_SRC_DIR=${NEUTRON_SRC_DIR:-$HOME/neutron/core}
# The chat port is resolved from NEUTRON_PORT (live env, then a .env pin) after
# the checkout is in hand — see resolve_port. 7800 is the server's own default.
CHAT_PORT=7800

# Auto-start + service + backup are ON by default (the hardened daily-driver
# experience); each has a --no-… opt-out.
DO_START=1
DO_SERVICE=1
DO_BACKUP=1
DO_OPEN=1
# GBrain is Neutron's real memory substrate (knowledge-graph + semantic recall);
# the runtime spawns `gbrain serve` over stdio MCP. Install it by default so a
# fresh self-host has REAL memory out of the box, with a --no-gbrain opt-out that
# preserves the graceful no-real-memory degradation. Source ref is overridable.
DO_GBRAIN=1
GBRAIN_REF=${NEUTRON_GBRAIN_REF:-github:garrytan/gbrain}
# Set to 1 by ensure_gbrain once the `gbrain` binary is confirmed on PATH — the
# final banner reads this so it never claims real memory when it silently degraded.
GBRAIN_INSTALLED=0
ASSUME_YES=0
DIR_OVERRIDE=""
# Offsite git remote for data backups. A --backup-remote <url> flag (or a live
# NEUTRON_BACKUP_REMOTE env) is persisted to .env + wired into the backup timer
# so the scheduled push actually targets it. Empty → local git history only.
BACKUP_REMOTE=${NEUTRON_BACKUP_REMOTE:-}
# Set to 1 by ensure_claude_auth when the install finished but Claude auth did
# NOT actually complete — the final banner reads this so it never claims a
# functional first chat when auth is still required.
CLAUDE_AUTH_PENDING=0

# Set to 1 by apply_auth_gate when CLAUDE_AUTH_PENDING is still 1 after the auth
# step — the HARD GATE (ISSUES #318). A chat with no Claude substrate credential
# is unusable, so when auth never completed we MUST NOT install/boot the service,
# start the server, or open the browser onto a dead chat. The install stops at
# "one step left" instead. (The app-level chat-surface gate is the defense-in-
# depth backstop for a box started by other means.)
APP_GATED_ON_AUTH=0

# Set to 1 ONLY when ensure_claude_auth actually ran the interactive
# `claude setup-token` path (real tty or the NEUTRON_FORCE_INTERACTIVE_AUTH
# seam). That path scrolls the `claude` CLI's onboarding noise over our branded
# banner, so the call site reclaims the screen afterward (ui_reclaim_after_auth).
# Stays 0 on the pre-detected, CLI-absent, and no-TTY guidance paths — those
# print at most a line or two and have no TUI noise worth clearing.
CLAUDE_AUTH_RAN_INTERACTIVE=0

# ── UI theme (Neutron terminal aesthetic) ────────────────────────────────────
# A small, self-contained presentation layer: a branded banner, a cohesive
# violet/indigo + electric-cyan palette, numbered phase headers, a braille
# spinner for the long steps, and a final "you're live" panel.
#
# GRACEFUL DEGRADATION is the contract: every decorative element here is gated
# behind $FANCY, which is 1 ONLY when stdout is a real TTY (or an explicit test
# seam forces it), NO_COLOR is unset, and TERM is not "dumb". When $FANCY is 0
# the color vars are empty, the banner/phase/spinner/panel collapse to no-ops,
# and info()/warn()/die() emit the EXACT same bytes the pre-theme installer did
# — so `sh install.sh` piped, in CI, or to a dumb terminal prints clean plain
# text with no escape-code garbage and behaves identically. `curl | sh` to an
# interactive terminal keeps stdout a TTY, so the headline path is the pretty one.
# This is paint, not plumbing: the functional flow, flags, and exit codes are
# unchanged.
ESC=$(printf '\033')
FANCY=0
ui_init_theme() {
  if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
    # NEUTRON_UI_FORCE_COLOR=1 forces the colored branch without a real tty so
    # the unit test can exercise it deterministically (NO_COLOR still wins).
    if [ -t 1 ] || [ "${NEUTRON_UI_FORCE_COLOR:-0}" = 1 ]; then
      FANCY=1
    fi
  fi
  if [ "$FANCY" = 1 ]; then
    C_RESET="${ESC}[0m"; C_BOLD="${ESC}[1m"; C_DIM="${ESC}[2m"
    C_BRAND="${ESC}[38;5;141m"    # violet — wordmark + structure
    C_BRAND2="${ESC}[38;5;99m"    # deep indigo — gutters + rules
    C_BRAND3="${ESC}[38;5;63m"    # darker indigo — gradient floor
    C_ACCENT="${ESC}[38;5;51m"    # electric cyan — links, spinner, highlights
    C_OK="${ESC}[38;5;48m"        # green — success
    C_WARN="${ESC}[38;5;214m"     # amber — warnings
    C_ERR="${ESC}[38;5;203m"      # red — errors
    C_MUTE="${ESC}[38;5;245m"     # soft gray — secondary text / the tag
    HIDE_CURSOR="${ESC}[?25l"; SHOW_CURSOR="${ESC}[?25h"; CLR_LINE="${ESC}[2K"
  else
    C_RESET=''; C_BOLD=''; C_DIM=''
    C_BRAND=''; C_BRAND2=''; C_BRAND3=''; C_ACCENT=''
    C_OK=''; C_WARN=''; C_ERR=''; C_MUTE=''
    HIDE_CURSOR=''; SHOW_CURSOR=''; CLR_LINE=''
  fi
}
ui_init_theme

# Track the background spinner subshell pid so BOTH the normal stop path and the
# cleanup trap can reap it. Declared here — before the traps are armed — so an
# early signal never reads an unset var under `set -u`.
SPIN_PID=''

# Stop the background spinner subshell if one is running. Idempotent: safe to call
# from the normal spin_end path AND from the signal/EXIT cleanup trap, so the two
# never double-kill noisily. The trap path is the one that matters: a direct
# `kill -TERM <installer-pid>` reaches the parent via the trap but NOT the spinner
# subshell (only Ctrl-C, delivered to the whole process group, kills the subshell
# implicitly), so without this the spinner orphans and keeps drawing frames to the
# terminal after the script has already exited.
stop_spinner() {
  [ -n "${SPIN_PID:-}" ] || return 0
  kill "$SPIN_PID" 2>/dev/null || true
  wait "$SPIN_PID" 2>/dev/null || true
  SPIN_PID=''
}

# Restore the cursor + reset color on any exit — a spinner may be mid-flight when
# a step dies. Stop the spinner FIRST so no orphaned subshell keeps drawing after
# exit. No-op (and no output) in plain mode.
ui_cleanup() { stop_spinner; [ "$FANCY" = 1 ] && printf '%s%s' "$SHOW_CURSOR" "$C_RESET" || true; }
# Split the signal traps from the EXIT trap. ui_cleanup RETURNS (does not exit),
# so a single `trap ui_cleanup EXIT INT TERM` would swallow SIGINT/SIGTERM: the
# handler runs, the script keeps going, and it exits 0 — losing cancellation and
# the conventional 130/143 codes (dangerous mid-install). EXIT stays cleanup-only;
# the signal handlers clean up THEN re-exit with 128+signo.
trap ui_cleanup EXIT
trap 'ui_cleanup; exit 130' INT
trap 'ui_cleanup; exit 143' TERM

# Branded launch banner — an ANSI-shadow NEUTRON wordmark with a violet→indigo
# vertical gradient and an atom motif. Colored/TTY runs only; piped/CI runs stay
# silent (the per-step info lines narrate the flow in plain mode). Falls back to
# a compact one-line wordmark on narrow terminals.
ui_banner() {
  [ "$FANCY" = 1 ] || return 0
  _cols=${COLUMNS:-}
  [ -n "$_cols" ] || _cols=$(tput cols 2>/dev/null || echo 80)
  printf '\n'
  if [ "$_cols" -ge 70 ] 2>/dev/null; then
    printf '   %s███╗   ██╗ ███████╗ ██╗   ██╗ ████████╗ ██████╗   ██████╗  ███╗   ██╗%s\n' "$C_BRAND" "$C_RESET"
    printf '   %s████╗  ██║ ██╔════╝ ██║   ██║ ╚══██╔══╝ ██╔══██╗ ██╔═══██╗ ████╗  ██║%s\n' "$C_BRAND" "$C_RESET"
    printf '   %s██╔██╗ ██║ █████╗   ██║   ██║    ██║    ██████╔╝ ██║   ██║ ██╔██╗ ██║%s\n' "$C_BRAND2" "$C_RESET"
    printf '   %s██║╚██╗██║ ██╔══╝   ██║   ██║    ██║    ██╔══██╗ ██║   ██║ ██║╚██╗██║%s\n' "$C_BRAND2" "$C_RESET"
    printf '   %s██║ ╚████║ ███████╗ ╚██████╔╝    ██║    ██║  ██║ ╚██████╔╝ ██║ ╚████║%s\n' "$C_BRAND3" "$C_RESET"
    printf '   %s╚═╝  ╚═══╝ ╚══════╝  ╚═════╝     ╚═╝    ╚═╝  ╚═╝  ╚═════╝  ╚═╝  ╚═══╝%s\n' "$C_BRAND3" "$C_RESET"
  else
    printf '   %s⚛%s  %sN E U T R O N%s\n' "$C_ACCENT" "$C_RESET" "$C_BOLD$C_BRAND" "$C_RESET"
  fi
  printf '   %s⚛ self-host · your agent · your machine%s\n\n' "$C_MUTE" "$C_RESET"
}

# Reclaim the screen after an INTERACTIVE `claude setup-token` run. That path
# (ensure_claude_auth, FORCE_INTERACTIVE seam or a real tty) lets the `claude`
# CLI dump its first-run onboarding banner / theme prompt / tips, which scroll
# our branded ui_banner off the top of the screen. In FANCY mode on a real TTY
# only, clear the terminal and redraw the wordmark so the install resumes on the
# Neutron logo. The clear also wipes ensure_claude_auth's outcome line, so we
# re-emit a one-liner confirming the result after the redraw (never drop it).
#
# STRICT no-op unless ALL of: FANCY=1, the interactive auth path actually ran,
# AND stdout is a real TTY. NEVER clears in plain / CI / piped output — that path
# has no TUI noise to clear and must stay byte-identical (and clearing a non-TTY
# would emit raw escape garbage). The TTY gate is a real `[ -t 1 ]`, not the
# NEUTRON_UI_FORCE_COLOR seam, so forced-color tests still observe the no-op.
ui_reclaim_after_auth() {
  [ "$FANCY" = 1 ] || return 0
  [ "${CLAUDE_AUTH_RAN_INTERACTIVE:-0}" = 1 ] || return 0
  [ -t 1 ] || return 0
  clear 2>/dev/null || printf '%s' "${ESC}[2J${ESC}[H"
  ui_banner
  if [ "$CLAUDE_AUTH_PENDING" = 1 ]; then
    warn "Claude auth still pending — run: claude setup-token (then add the printed CLAUDE_CODE_OAUTH_TOKEN=… to .env)"
  else
    info "✓ Claude auth detected"
  fi
}

# Numbered phase header ("1/6 · Dependencies"). Leading blank line + a single
# accent separator carry the structure — no repeated full-width rule, so the six
# headers read as rhythm rather than a templated stack. Colored runs only; in
# plain mode the existing per-step info lines narrate the flow, so this is a
# no-op and piped/CI output stays byte-identical to the pre-theme run.
ui_phase() {
  [ "$FANCY" = 1 ] || return 0
  printf '\n  %s%s%s %s·%s %s%s%s\n' \
    "$C_ACCENT$C_BOLD" "$1" "$C_RESET" "$C_BRAND2" "$C_RESET" "$C_BOLD$C_BRAND" "$2" "$C_RESET"
}

# Sub-second spinner tick. POSIX `sleep` only guarantees integer seconds; GNU and
# BSD sleep accept fractions, but some /bin/sh sleeps (older busybox) reject a
# fractional argument outright. Probe once and pick the most portable ~tenth-of-a-
# second wait: fractional sleep → perl select → a coarse 1s integer fallback (the
# spinner just ticks slower; the install itself is unaffected). Only wired up when
# the spinner can actually run (FANCY); the plain path never calls it.
spin_sleep() { sleep 1; }
ui_init_spin_sleep() {
  if sleep 0.05 2>/dev/null; then
    spin_sleep() { sleep 0.08; }
  elif command -v perl >/dev/null 2>&1; then
    spin_sleep() { perl -e 'select undef, undef, undef, 0.08'; }
  fi
}
[ "$FANCY" = 1 ] && ui_init_spin_sleep

# Braille spinner for the long, output-noisy steps (deps, migrate, service). In
# plain mode spin_start just prints the step's info line and spin_end is a no-op,
# so the wrapped command streams exactly as the pre-theme installer did.
SPIN_LABEL=''
_spin_frame() {
  _n=$1; _c=0
  for _fr in ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏; do
    [ "$_c" = "$_n" ] && { printf '%s' "$_fr"; return 0; }
    _c=$((_c + 1))
  done
}
spin_start() {
  SPIN_LABEL=$1
  if [ "$FANCY" != 1 ]; then
    info "$SPIN_LABEL"
    return 0
  fi
  printf '%s' "$HIDE_CURSOR"
  (
    _i=0
    while :; do
      printf '\r  %s%s%s %s' "$C_ACCENT" "$(_spin_frame $((_i % 10)))" "$C_RESET" "$SPIN_LABEL"
      _i=$((_i + 1))
      spin_sleep
    done
  ) &
  SPIN_PID=$!
}
spin_end() {
  _rc=$1
  _msg=${2:-$SPIN_LABEL}
  [ "$FANCY" = 1 ] || return 0
  stop_spinner
  printf '\r%s%s' "$CLR_LINE" "$SHOW_CURSOR"
  if [ "$_rc" = 0 ]; then
    printf '  %s✓%s %s\n' "$C_OK" "$C_RESET" "$_msg"
  else
    printf '  %s✗%s %s\n' "$C_ERR" "$C_RESET" "$SPIN_LABEL"
  fi
}

# ── helpers ──────────────────────────────────────────────────────────────────
# Themed but plain-identical: with empty color vars (the $FANCY=0 path) these
# emit exactly 'neutron: …' / 'neutron: WARNING: …' / 'neutron: ERROR: …'.
info()  { printf '%sneutron:%s %s\n' "$C_MUTE" "$C_RESET" "$*"; }
warn()  { printf '%sneutron: WARNING:%s %s\n' "$C_WARN" "$C_RESET" "$*" >&2; }
die()   { printf '%sneutron: ERROR:%s %s\n' "$C_ERR" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  # Print the header comment block (lines starting with '#') minus the shebang.
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

# Installer data-dir default. The shared resolve_neutron_home floors at the
# LEGACY flat $HOME/neutron; upgrade that floor to the hardened nested
# $HOME/neutron/data (single ~/neutron umbrella, SPEC § 2.6) while honoring any
# explicit pin. A user who wants a different data dir pins NEUTRON_HOME to ANY
# other path — that is returned verbatim and never upgraded. uninstall.sh carries
# a byte-identical copy so both agree on the dir to create/remove.
resolve_install_home() {
  _h=$(resolve_neutron_home "${1:-}")
  [ "$_h" = "$HOME/neutron" ] && _h="$HOME/neutron/data"
  printf '%s\n' "$_h"
}

# Resolve the HTTP port the server binds — and therefore the URL we print —
# the same way the gateway does: NEUTRON_PORT (live env, then a .env pin), else
# 7800. Never hardcode if the operator pinned a port.
resolve_port() {
  _p=${NEUTRON_PORT:-}
  [ -n "$_p" ] || _p=$(dotenv_get "${1:-}" NEUTRON_PORT)
  [ -n "$_p" ] || _p=7800
  printf '%s\n' "$_p"
}

# Migrate an OLD flat-layout install into the nested data dir. Triggers only for
# the default-layout upgrade: a legacy $HOME/neutron/project.db is present AND the
# resolved data dir is the new $HOME/neutron/data. A custom NEUTRON_HOME /
# NEUTRON_DB_PATH is never touched. Moves the DB plus its -shm/-wal sidecars.
migrate_flat_layout() {
  _home=$1
  [ "$_home" = "$HOME/neutron/data" ] || return 0
  _legacy="$HOME/neutron"
  [ -f "$_legacy/project.db" ] || return 0
  mkdir -p "$_home"
  for _f in project.db project.db-shm project.db-wal; do
    if [ -f "$_legacy/$_f" ] && [ ! -e "$_home/$_f" ]; then
      info "migrating legacy flat-layout $_f → $_home/"
      mv "$_legacy/$_f" "$_home/$_f"
    fi
  done
}

# Pin KEY=value in a dotenv file: replace any existing assignment (commented or
# not, export or not), else append. Used to lock NEUTRON_HOME to the resolved
# data dir so the server (which auto-loads .env) opens the SAME dir the installer
# migrated — the install↔server agreement the shared-resolver parity protects.
persist_env_var() {
  _ef=$1
  _k=$2
  _v=$3
  [ -f "$_ef" ] || : > "$_ef"
  if grep -qE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?${_k}=" "$_ef" 2>/dev/null; then
    _tmp=$(mktemp 2>/dev/null || printf '%s\n' "$_ef.tmp.$$")
    grep -vE "^[[:space:]]*#?[[:space:]]*(export[[:space:]]+)?${_k}=" "$_ef" > "$_tmp" 2>/dev/null || true
    printf '%s=%s\n' "$_k" "$_v" >> "$_tmp"
    mv "$_tmp" "$_ef"
  else
    printf '%s=%s\n' "$_k" "$_v" >> "$_ef"
  fi
}

# Generate a random hex secret — 48 hex chars (24 bytes), matching the server's
# randomBytes(24).toString('hex') in open/server.ts. Prefer openssl, fall back to
# /dev/urandom via od (POSIX). Prints nothing if neither is available (the caller
# warns and leaves the server to its ephemeral-secret path). A test seam
# (NEUTRON_INSTALL_SECRET_CMD) injects a deterministic value so the cookie-secret
# tests don't depend on the host's randomness source.
gen_secret() {
  if [ -n "${NEUTRON_INSTALL_SECRET_CMD:-}" ]; then
    sh -c "$NEUTRON_INSTALL_SECRET_CMD" 2>/dev/null && return 0
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    _s=$(openssl rand -hex 24 2>/dev/null || true)
    [ -n "$_s" ] && { printf '%s\n' "$_s"; return 0; }
  fi
  if [ -r /dev/urandom ]; then
    _s=$(od -An -N24 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' || true)
    [ -n "$_s" ] && { printf '%s\n' "$_s"; return 0; }
  fi
  return 0
}

# Pin a STABLE onboarding-chat cookie secret in .env. The Open server
# (open/server.ts) generates an EPHEMERAL secret whenever
# NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET is unset — which resets the owner's
# logged-in session on EVERY restart. Generate one random secret at install time
# and persist it so the session survives restarts. Idempotent: a secret already
# pinned in .env (a prior install, or one the user set) is never regenerated, so
# re-running the installer keeps existing sessions valid. A value present only in
# the live env is pinned into .env so it, too, survives restarts.
persist_cookie_secret() {
  _ef=$1
  # Already pinned in .env → leave it untouched (stable across re-installs).
  if [ "$(dotenv_get "$_ef" NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET)" != "" ]; then
    return 0
  fi
  # Present only in the live env → pin THAT value so restarts keep the session.
  _existing=${NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET:-}
  if [ -n "$_existing" ]; then
    persist_env_var "$_ef" NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET "$_existing"
    info "pinned NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET in .env (owner session persists across restarts)"
    return 0
  fi
  # Neither → generate a fresh random secret and pin it.
  _secret=$(gen_secret)
  if [ -z "$_secret" ]; then
    warn "could not generate a cookie secret (no openssl or /dev/urandom) — the owner"
    warn "  session will reset on each restart until you set"
    warn "  NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET=… in $_ef"
    return 0
  fi
  persist_env_var "$_ef" NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET "$_secret"
  info "generated a stable NEUTRON_ONBOARDING_CHAT_COOKIE_SECRET → .env (owner session persists across restarts)"
}

# Symlink the `neutron` CLI onto PATH (~/.local/bin) so the owner can drive the
# service without launchctl/systemctl. Warns if that dir is not on PATH.
install_neutron_cli() {
  [ -f "$SRC_DIR/bin/neutron" ] || return 0
  _bindir="$HOME/.local/bin"
  mkdir -p "$_bindir"
  ln -sf "$SRC_DIR/bin/neutron" "$_bindir/neutron"
  info "installed the 'neutron' CLI → $_bindir/neutron"
  case ":${PATH:-}:" in
    *":$_bindir:"*) : ;;
    *)
      warn "$_bindir is not on your PATH — add it to use the 'neutron' command:"
      warn "  export PATH=\"$_bindir:\$PATH\""
      ;;
  esac
}

# Confirm before a network/disk action. Honors --yes; refuses non-interactively
# without it (the curl | sh path MUST pass --yes).
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  if [ -t 0 ]; then
    printf 'neutron: %s [y/N] ' "$1"
    read -r _ans
  elif [ -e /dev/tty ]; then
    printf 'neutron: %s [y/N] ' "$1" > /dev/tty
    read -r _ans < /dev/tty
  else
    die "non-interactive and no --yes/-y given — re-run with --yes (required for the curl | sh path)"
  fi
  case "$_ans" in
    y|Y|yes|YES) return 0 ;;
    *) info "aborted"; exit 0 ;;
  esac
}

# Ensure `bun` is on PATH, offering to install it via Bun's official installer
# when it is missing. Consent rules (per the self-host onboarding spec):
#   - `--yes`               → auto-install, no prompt (the curl | sh path)
#   - interactive (a tty)   → prompt y/N; install on yes
#   - declined, OR no tty and no --yes → print manual instructions, exit non-zero
# After a successful install we add Bun's bin dir ($BUN_INSTALL/bin, default
# ~/.bun/bin) to PATH for the rest of this process so the subsequent `bun
# install` / `bun run migrate` steps find it without a new shell. A test seam
# (NEUTRON_BUN_INSTALL_CMD) replaces the network installer so the unit tests can
# exercise both the install-attempt and still-missing paths offline.
ensure_bun() {
  command -v bun >/dev/null 2>&1 && return 0
  warn "bun is not installed — Neutron runs on Bun."
  _consent=0
  if [ "$ASSUME_YES" = 1 ]; then
    _consent=1
  elif [ -t 0 ]; then
    printf 'neutron: install bun now via the official installer (curl -fsSL https://bun.sh/install | bash)? [y/N] '
    read -r _ans
    case "$_ans" in y|Y|yes|YES) _consent=1 ;; esac
  fi
  if [ "$_consent" != 1 ]; then
    warn "Install bun, then re-run this installer:"
    warn "  curl -fsSL https://bun.sh/install | bash"
    warn "  (or see https://bun.sh)"
    die "missing prerequisite: bun"
  fi
  info "installing bun (curl -fsSL https://bun.sh/install | bash)"
  if [ -n "${NEUTRON_BUN_INSTALL_CMD:-}" ]; then
    sh -c "$NEUTRON_BUN_INSTALL_CMD" || die "bun install failed — install it manually (https://bun.sh) and retry"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required to auto-install bun — install bun manually (https://bun.sh) and retry"
    curl -fsSL https://bun.sh/install | bash || die "bun install failed — install it manually (https://bun.sh) and retry"
  fi
  BUN_INSTALL=${BUN_INSTALL:-$HOME/.bun}
  PATH="$BUN_INSTALL/bin:$PATH"
  export PATH
  command -v bun >/dev/null 2>&1 || \
    die "bun still not found after install — open a new shell (or add $BUN_INSTALL/bin to PATH) and re-run this installer"
  info "bun installed ($(command -v bun))"
}

# Install the GBrain memory binary so a fresh self-host has REAL memory.
#
# WHY THIS EXISTS: the runtime (gbrain-memory/) spawns `gbrain serve` over stdio
# MCP for the knowledge-graph + semantic recall that is core to the experience.
# When the binary is ABSENT it degrades SILENTLY — entity pages still land on
# disk, but every KG/semantic memory op fails (latched after the first
# "Executable not found in $PATH: gbrain"; see gbrain-memory/memory-store.ts
# isGbrainBinaryMissingError). Before this step install.sh had ZERO gbrain
# references, so every fresh install ran without real memory. This closes that.
#
# CONTRACT: GBrain is REQUIRED, not best-effort. GBrain is an external
# dependency (github.com/garrytan/gbrain, MIT, installed onto PATH via
# `bun install -g`). A successful `neutron` install GUARANTEES `gbrain` on PATH:
# transient install failures (network/github/build hiccups) are RETRIED, and if
# the binary is STILL unresolvable afterwards we ABORT the install with a clear,
# actionable error rather than silently shipping degraded memory. The ONLY way
# to install without it is the explicit --no-gbrain / NEUTRON_SKIP_GBRAIN=1
# opt-out, which stays graceful (the runtime degrades to on-disk entity pages,
# no knowledge-graph / semantic recall).
ensure_gbrain() {
  if [ "$DO_GBRAIN" != 1 ] || [ "${NEUTRON_SKIP_GBRAIN:-}" = 1 ]; then
    warn "skipping GBrain memory install (--no-gbrain / NEUTRON_SKIP_GBRAIN)."
    warn "  Memory degrades to entity pages on disk — NO knowledge-graph / semantic recall."
    warn "  Enable it later with:  bun install -g $GBRAIN_REF   (then restart Neutron)"
    return 0
  fi

  # `bun install -g` drops global bins into $BUN_INSTALL/bin (default ~/.bun/bin).
  # The bun installer wires that onto the login shell, but THIS process may not
  # have it yet (esp. when bun was just installed in ensure_bun). Put it on PATH
  # so both the idempotent pre-check and the post-install probe can find gbrain.
  _bun_bin=${BUN_INSTALL:-$HOME/.bun}/bin
  case ":$PATH:" in *":$_bun_bin:"*) : ;; *) PATH="$_bun_bin:$PATH"; export PATH ;; esac

  # Idempotent: an existing gbrain (re-install, or hand-installed) → done.
  if command -v gbrain >/dev/null 2>&1; then
    GBRAIN_INSTALLED=1
    info "GBrain memory already installed ($(command -v gbrain)) — real KG/semantic memory enabled"
    return 0
  fi

  # The test seam replaces the real network install with an injected command;
  # production uses the canonical `bun install -g <ref>` from GBrain's README.
  if [ -n "${NEUTRON_GBRAIN_INSTALL_CMD:-}" ]; then
    _gb_cmd="$NEUTRON_GBRAIN_INSTALL_CMD"
  else
    _gb_cmd="bun install -g $GBRAIN_REF"
  fi

  spin_start "installing GBrain memory ($GBRAIN_REF)"
  _gb_log=$(mktemp 2>/dev/null || printf '%s\n' "${TMPDIR:-/tmp}/neutron-gbrain.$$")

  # Retry transient failures (network blips, github rate limits, flaky native
  # builds) — a hiccup shouldn't doom a REQUIRED dependency. NEUTRON_GBRAIN_ATTEMPTS
  # / NEUTRON_GBRAIN_RETRY_DELAY are test/override seams; defaults are 3 attempts
  # with a 2s backoff between them.
  _gb_attempts=${NEUTRON_GBRAIN_ATTEMPTS:-3}
  _gb_delay=${NEUTRON_GBRAIN_RETRY_DELAY:-2}
  _gb_ok=0
  _gb_n=1
  while [ "$_gb_n" -le "$_gb_attempts" ]; do
    if sh -c "$_gb_cmd" >"$_gb_log" 2>&1; then
      _gb_ok=1
      break
    fi
    if [ "$_gb_n" -lt "$_gb_attempts" ]; then
      warn "GBrain install attempt $_gb_n/$_gb_attempts failed — retrying in ${_gb_delay}s…"
      [ "$_gb_delay" = 0 ] || sleep "$_gb_delay"
    fi
    _gb_n=$((_gb_n + 1))
  done

  if [ "$_gb_ok" = 1 ]; then
    # The global bin dir may have just been created — re-probe PATH before lookup.
    case ":$PATH:" in *":$_bun_bin:"*) : ;; *) PATH="$_bun_bin:$PATH"; export PATH ;; esac
    if command -v gbrain >/dev/null 2>&1; then
      GBRAIN_INSTALLED=1
      spin_end 0 "GBrain memory installed — real KG/semantic memory enabled"
      # spin_end is a no-op in plain mode; echo the confirmation so the line is
      # visible there too (mirrors the migrations step).
      [ "$FANCY" = 1 ] || info "GBrain memory installed ($(command -v gbrain)) — real KG/semantic memory enabled"
      rm -f "$_gb_log"
      return 0
    fi
    # Installed without error but not resolvable — almost always a PATH gap.
    # GBrain is REQUIRED, so this is fatal: ABORT with the exact fix (and the
    # --no-gbrain escape hatch) rather than silently shipping degraded memory.
    spin_end 1
    cat "$_gb_log" >&2
    rm -f "$_gb_log"
    die "GBrain installed but 'gbrain' is not on PATH (expected in $_bun_bin).
  GBrain is REQUIRED for Neutron memory (knowledge-graph + semantic recall).
  Fix: ensure $_bun_bin is on your PATH, then re-run the installer.
  Or re-run with --no-gbrain to install WITHOUT memory (degrades to on-disk entity pages)."
  fi

  # Every attempt failed (offline, ref unreachable, build error). GBrain is
  # REQUIRED — ABORT loudly with the manual-recovery command and the opt-out,
  # instead of leaving the user with silently degraded memory.
  spin_end 1
  cat "$_gb_log" >&2
  rm -f "$_gb_log"
  die "GBrain memory install failed after $_gb_attempts attempt(s) — GBrain is REQUIRED.
  Install it manually, then re-run the installer:
    bun install -g $GBRAIN_REF
  Or re-run with --no-gbrain to install WITHOUT memory (degrades to on-disk entity pages; no KG/semantic recall)."
}

# Run `claude setup-token` and capture the long-lived `sk-ant-oat…` token it
# prints to stdout, mirroring the Managed install-token flow (the
# install-token-script renderer in the onboarding-api landing module).
# `claude setup-token` does NOT persist the token anywhere itself (per
# Anthropic's docs: "prints a token to the terminal. It does not save the token
# anywhere"), so we MUST tee its output and grep the token out — otherwise a
# "successful" run leaves nothing the server can read. We tee the live output to
# stderr so the user still sees the browser prompts, and print ONLY the captured
# token (or nothing) on stdout for the caller to consume. A test seam
# (NEUTRON_CLAUDE_SETUP_CMD) replaces the interactive invocation so tests never
# pop a real browser.
run_setup_token_capture() {
  _tmp=$(mktemp 2>/dev/null || printf '%s\n' "${TMPDIR:-/tmp}/neutron-claude-token.$$")
  if [ -n "${NEUTRON_CLAUDE_SETUP_CMD:-}" ]; then
    sh -c "$NEUTRON_CLAUDE_SETUP_CMD" 2>&1 | tee "$_tmp" >&2 || true
  elif [ -t 0 ]; then
    claude setup-token 2>&1 | tee "$_tmp" >&2 || true
  else
    # Behind a pipe (`curl … | sh -s -- --yes`) stdin is the script, not a
    # keyboard, so the setup-token TUI/OAuth handoff cannot read input. Bind it
    # to the controlling terminal (/dev/tty) so the AUTH step still runs even on
    # a non-interactive-stdin install. _terminal_available() guarantees /dev/tty
    # is usable before we reach this branch. NEUTRON_CLAUDE_SETUP_TTY overrides
    # the device so this real-`claude … <tty` binding path is testable without a
    # genuine controlling terminal (ISSUES #318, Argus minor — see the
    # tty-binding test in tests/integration/install-auth-gate.test.ts).
    claude setup-token <"${NEUTRON_CLAUDE_SETUP_TTY:-/dev/tty}" 2>&1 | tee "$_tmp" >&2 || true
  fi
  # Strip ANSI color/formatting before matching: some `claude` builds wrap the
  # printed token in escape codes, which would defeat a raw grep and cause a
  # spurious "no token captured" → false-negative auth gate (ISSUES #318, Argus
  # minor). Then pull out the long-lived subscription token.
  sed "s/$(printf '\033')\[[0-9;]*[A-Za-z]//g" "$_tmp" 2>/dev/null \
    | grep -oE 'sk-ant-oat[0-9]{2}-[A-Za-z0-9_-]+' | tail -n1
  rm -f "$_tmp" 2>/dev/null || true
}

# True when an interactive terminal is reachable for the `claude setup-token`
# OAuth handoff. stdin-tty is the classic case; but the headline install is
# `curl … | sh` where stdin is the PIPE, not a tty — yet the user is still at a
# real terminal reachable via /dev/tty. We probe /dev/tty (openable r+w) so the
# AUTH step can run even under `--yes`. Test seams: NEUTRON_FORCE_INTERACTIVE_AUTH
# forces true (capture/persist path is exercised without a real tty);
# NEUTRON_ASSUME_NO_TTY forces false (the hard-stop gate is exercised
# deterministically regardless of the test runner's /dev/tty).
_terminal_available() {
  [ "${NEUTRON_ASSUME_NO_TTY:-0}" = 1 ] && return 1
  [ "${NEUTRON_FORCE_INTERACTIVE_AUTH:-0}" = 1 ] && return 0
  [ -t 0 ] && return 0
  ( exec 3<>/dev/tty ) 2>/dev/null && return 0
  return 1
}

# The HARD AUTH GATE (ISSUES #318). Call right after ensure_claude_auth: when
# auth never completed (CLAUDE_AUTH_PENDING=1) the box has no working Claude
# substrate, so a started chat is a dead chat. Flip the gate and force
# start/open OFF so the rest of the script skips the service install, the
# background start, and the browser open — the owner is left at a clear
# "authenticate first" banner instead of an unusable chat window.
apply_auth_gate() {
  if [ "$CLAUDE_AUTH_PENDING" = 1 ]; then
    APP_GATED_ON_AUTH=1
    DO_START=0
    DO_OPEN=0
  fi
}

# Persist a captured subscription token to the checkout .env as
# CLAUDE_CODE_OAUTH_TOKEN — the single-owner equivalent of the Managed
# SecretsStore write. This is the value open/composer.ts (resolveOpenLlmPool)
# reads to power the LLM substrate, so persisting it here is what makes the
# auth actually take effect on the next server start. Replaces any prior
# assignment rather than appending a duplicate.
persist_oauth_token_to_env() {
  _ef=$1
  _tok=$2
  [ -f "$_ef" ] || : > "$_ef"
  if grep -qE '^[[:space:]]*(export[[:space:]]+)?CLAUDE_CODE_OAUTH_TOKEN=' "$_ef" 2>/dev/null; then
    _tmp=$(mktemp 2>/dev/null || printf '%s\n' "$_ef.tmp.$$")
    grep -vE '^[[:space:]]*(export[[:space:]]+)?CLAUDE_CODE_OAUTH_TOKEN=' "$_ef" > "$_tmp" 2>/dev/null || true
    printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$_tok" >> "$_tmp"
    mv "$_tmp" "$_ef"
  else
    printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$_tok" >> "$_ef"
  fi
}

# Detect Claude auth state and guide the user HONESTLY, mirroring the Managed
# onboarding install-token flow: the canonical command is `claude setup-token`,
# which opens a browser for OAuth consent and PRINTS a long-lived subscription
# token (`sk-ant-oat…`) to stdout. The substrate reads either
# CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API billing).
#
# HONESTY CONTRACT (the whole point of this function): never report auth as
# complete unless a token/key is actually present. setup-token's browser OAuth
# can only complete with a real interactive terminal, so:
#   - already authed (token/key in live env OR the checkout .env) → one-line ✓
#   - interactive TTY, claude present, not authed → run setup-token, CAPTURE the
#     printed token, persist it to .env, and only then print ✓. If no token is
#     captured (cancelled sign-in), print manual next-steps + mark auth PENDING.
#   - --yes / non-interactive / NO TTY → do NOT run setup-token (it cannot
#     complete a browser OAuth here): print the exact manual command + the
#     API-key alternative and mark auth PENDING. The overall install still
#     succeeds (bun + migrate done); the banner reflects that auth is pending.
#   - claude absent → print install + auth instructions; mark auth PENDING.
# Never introduces a direct api.anthropic.com call — the LLM substrate is the
# spawned `claude` CLI. CLAUDE_AUTH_PENDING is read by the final banner.
# NEUTRON_FORCE_INTERACTIVE_AUTH=1 is a test seam that forces the interactive
# branch without a real tty (so the capture/persist/verify path is testable).
ensure_claude_auth() {
  _envfile="${SRC_DIR:-$(pwd)}/.env"
  _oauth=${CLAUDE_CODE_OAUTH_TOKEN:-}
  [ -n "$_oauth" ] || _oauth=$(dotenv_get "$_envfile" CLAUDE_CODE_OAUTH_TOKEN)
  _apikey=${ANTHROPIC_API_KEY:-}
  [ -n "$_apikey" ] || _apikey=$(dotenv_get "$_envfile" ANTHROPIC_API_KEY)
  if [ -n "$_oauth" ] || [ -n "$_apikey" ]; then
    info "✓ Claude auth detected"
    return 0
  fi

  if ! command -v claude >/dev/null 2>&1; then
    warn "claude CLI not found — Neutron spawns it as its LLM substrate. Install it with:"
    warn "  curl -fsSL https://claude.ai/install.sh | bash"
    warn "Then authenticate with EITHER:"
    warn "  claude setup-token                       # subscription OAuth (opens a browser)"
    warn "  or set ANTHROPIC_API_KEY=sk-ant-… in $_envfile"
    CLAUDE_AUTH_PENDING=1
    return 0
  fi

  # claude present but not authed. setup-token needs a real interactive terminal
  # to complete the browser OAuth handoff. We run it whenever ANY terminal is
  # reachable — stdin-tty OR /dev/tty behind a pipe — so even a non-interactive
  # `curl | sh -s -- --yes` performs the AUTH step (ISSUES #318: the owner's
  # `--yes` install used to SKIP auth and land in a dead chat). Only a box with
  # truly no terminal (CI, headless) falls through to the hard-stop below.
  if _terminal_available; then
    # We are about to let `claude setup-token` take over the terminal. Mark that
    # the interactive path ran so the call site can reclaim the screen + redraw
    # the banner once the CLI's onboarding noise is done.
    CLAUDE_AUTH_RAN_INTERACTIVE=1
    info "connecting your Anthropic account — a browser window will open (claude setup-token)"
    _tok=$(run_setup_token_capture)
    if [ -n "$_tok" ]; then
      persist_oauth_token_to_env "$_envfile" "$_tok"
      info "wrote CLAUDE_CODE_OAUTH_TOKEN to $_envfile"
      info "✓ Claude auth detected"
      return 0
    fi
    # No sk-ant-oat… token reached us. Two cases land here: the user cancelled
    # sign-in (genuinely unauth'd), OR this `claude` build authenticated to its
    # OWN credential store but printed no token to stdout. Either way Neutron's
    # substrate reads the credential from .env (open/composer.ts
    # resolveOpenLlmPool keys on CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY —
    # NOT claude's ambient store), so we still cannot start a working chat. Stay
    # gated, but explain WHY honestly rather than only blaming a cancelled
    # sign-in (ISSUES #318, Argus minor — false-negative gate messaging).
    warn "claude setup-token finished but no token was captured for Neutron to store."
    warn "Even if claude itself is now signed in, Neutron reads the subscription token"
    warn "from $_envfile — so first chat still needs ONE of:"
    warn "  claude setup-token                       # re-run, then copy the printed"
    warn "                                           # CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat… line into $_envfile"
    warn "  or set ANTHROPIC_API_KEY=sk-ant-… in $_envfile"
    CLAUDE_AUTH_PENDING=1
    return 0
  fi

  # Truly no terminal (CI / headless, no stdin tty AND no /dev/tty). setup-token
  # CANNOT complete a browser OAuth here, so we do NOT run it — we print exactly
  # what to run and mark auth PENDING. apply_auth_gate then HARD-STOPS the
  # install before any service/start/open, so the box never lands in a dead chat.
  warn "Claude is not authenticated yet — this is the LAST step before first chat."
  warn "No interactive terminal is available, so the install will STOP here (it will"
  warn "not start an unusable chat). Run ONE of these, then re-run the installer:"
  warn "  claude setup-token                       # subscription OAuth (opens a browser); then add the"
  warn "                                           # printed CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat… line to $_envfile"
  warn "  or set ANTHROPIC_API_KEY=sk-ant-… in $_envfile   # API billing"
  CLAUDE_AUTH_PENDING=1
}

# ── parse args ───────────────────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --start) DO_START=1; shift ;;
    --no-start) DO_START=0; shift ;;
    --no-service) DO_SERVICE=0; shift ;;
    --no-gbrain) DO_GBRAIN=0; shift ;;
    --no-backup) DO_BACKUP=0; shift ;;
    --no-open) DO_OPEN=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dir) DIR_OVERRIDE=${2:-}; [ "$DIR_OVERRIDE" != "" ] || die "--dir needs a value"; shift 2 ;;
    --dir=*) DIR_OVERRIDE=${1#--dir=}; shift ;;
    --backup-remote) BACKUP_REMOTE=${2:-}; [ "$BACKUP_REMOTE" != "" ] || die "--backup-remote needs a value"; shift 2 ;;
    --backup-remote=*) BACKUP_REMOTE=${1#--backup-remote=}; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# ── branded launch ───────────────────────────────────────────────────────────
ui_banner
ui_phase "1/6" "Dependencies"

# ── bun bootstrap ────────────────────────────────────────────────────────────
# Neutron runs on Bun, and the very next steps (clone update, bun install) assume
# it. Offer to install it up front (before the clone) when it is missing so the
# rest of the run has it on PATH. No-op when bun is already present, so the test
# seams below still observe a clean, side-effect-free mode/DB resolution.
ensure_bun

# ── mode detection: in-place vs clone ────────────────────────────────────────
# LOCAL mode: we are inside a checkout (open/server.ts sits next to this script
# or in the current directory). REMOTE mode: clone the repo first.
SCRIPT_DIR=""
case "$0" in
  */*) SCRIPT_DIR=$(dirname -- "$0"); SCRIPT_DIR=$(cd -- "$SCRIPT_DIR" 2>/dev/null && pwd || true) ;;
esac

# Resolve the mode (local in-place vs remote clone) with NO side effects, so a
# test seam can observe it and so the clone only ever runs once we have decided.
# resolve_src_dir (shared with uninstall.sh) encodes the in-place detection so
# both scripts agree on WHICH checkout they act on — an explicit --dir holding a
# checkout, else this script's dir, else cwd; empty when none is found.
SRC_DIR=$(resolve_src_dir "$DIR_OVERRIDE" "$SCRIPT_DIR")

if [ "$SRC_DIR" != "" ]; then
  MODE=local
  CLONE_DIR=""
else
  MODE=remote
  CLONE_DIR=${DIR_OVERRIDE:-$DEFAULT_SRC_DIR}
fi

# Test seam (harness only): print the resolved mode and exit before any network
# or disk mutation. Lets the unit test assert mode detection deterministically.
if [ "${NEUTRON_INSTALL_PRINT_MODE:-}" = "1" ]; then
  if [ "$MODE" = "local" ]; then
    printf 'mode=local src=%s\n' "$SRC_DIR"
  else
    printf 'mode=remote clone=%s\n' "$CLONE_DIR"
  fi
  exit 0
fi

# Test seam (harness only): print the resolved data dir + the exact DB target
# the migrate step will write — honoring NEUTRON_DB_PATH / NEUTRON_HOME pinned in
# the resolved checkout's .env — then exit before any network or disk mutation.
# Lets the unit test assert install + server agree on the DB path.
if [ "${NEUTRON_INSTALL_PRINT_DB:-}" = "1" ]; then
  _seam_src=${SRC_DIR:-$(pwd)}
  _seam_home=$(resolve_install_home "$_seam_src/.env")
  _seam_db=$(resolve_db_target "$_seam_home" "$_seam_src/.env")
  printf 'home=%s\n' "$_seam_home"
  printf 'db=%s\n' "$_seam_db"
  exit 0
fi

# Test seam (harness only): run the Claude-auth detection/guidance in isolation
# and exit, without bun install / migrations. Lets the unit tests assert the
# auth-state branches (detected / CLI-absent) without a full install.
if [ "${NEUTRON_INSTALL_PRINT_AUTH:-}" = "1" ]; then
  ensure_claude_auth
  apply_auth_gate
  # Surface the screen-reclaim flag so the harness can assert it is SET only on
  # the interactive setup-token path and UNSET on the pre-authed / CLI-absent /
  # no-TTY paths (the call-site redraw itself is real-TTY-gated, untestable here).
  printf 'CLAUDE_AUTH_RAN_INTERACTIVE=%s\n' "$CLAUDE_AUTH_RAN_INTERACTIVE"
  # Surface the auth-gate decision (ISSUES #318) so the harness can assert that a
  # no-token / no-tty install HARD-STOPS: gated → start/open forced OFF.
  printf 'CLAUDE_AUTH_PENDING=%s\n' "$CLAUDE_AUTH_PENDING"
  printf 'APP_GATED_ON_AUTH=%s\n' "$APP_GATED_ON_AUTH"
  printf 'DO_START=%s\n' "$DO_START"
  printf 'DO_OPEN=%s\n' "$DO_OPEN"
  exit 0
fi

# Test seam (harness only): run the GBrain memory install/detect step in
# isolation and exit, without bun install / migrations. Lets the unit tests
# assert the install branches (already-present / installed-ok / install-failed /
# opted-out) via NEUTRON_GBRAIN_INSTALL_CMD without hitting the network.
if [ "${NEUTRON_INSTALL_PRINT_GBRAIN:-}" = "1" ]; then
  ensure_gbrain
  printf 'GBRAIN_INSTALLED=%s\n' "$GBRAIN_INSTALLED"
  exit 0
fi

if [ "$MODE" = "local" ]; then
  info "installing in place from existing checkout: $SRC_DIR"
else
  # ── REMOTE: clone (or update) into the code directory ──────────────────────
  command -v git >/dev/null 2>&1 || die "git is required to clone Neutron — install git and retry"
  if [ -d "$CLONE_DIR/.git" ]; then
    info "updating existing checkout in $CLONE_DIR"
    git -C "$CLONE_DIR" pull --ff-only || die "git pull failed in $CLONE_DIR"
  elif [ -d "$CLONE_DIR" ] && [ "$(ls -A "$CLONE_DIR" 2>/dev/null || true)" != "" ]; then
    die "$CLONE_DIR exists and is not a Neutron checkout — pass --dir <empty path> or remove it"
  else
    confirm "clone $NEUTRON_REPO into $CLONE_DIR?"
    info "cloning $NEUTRON_REPO into $CLONE_DIR"
    mkdir -p "$(dirname "$CLONE_DIR")"
    git clone --depth 1 "$NEUTRON_REPO" "$CLONE_DIR" || die "git clone failed"
  fi
  SRC_DIR=$CLONE_DIR
  [ -f "$SRC_DIR/open/server.ts" ] || die "clone did not produce open/server.ts — wrong NEUTRON_REPO?"
fi

cd "$SRC_DIR" || die "could not enter $SRC_DIR"

# ── prerequisites ────────────────────────────────────────────────────────────
# bun is already guaranteed by ensure_bun (run up front). claude auth is handled
# after migrations by ensure_claude_auth — right before the next-steps banner.
command -v git >/dev/null 2>&1 || warn "git not found — fine for an in-place install, needed for future updates"

# ── install deps ─────────────────────────────────────────────────────────────
# Spinner in fancy mode (bun's verbose output is captured and shown only on
# failure); plain mode streams bun install exactly as before.
spin_start "installing dependencies (bun install)"
if [ "$FANCY" = 1 ]; then
  _bun_log=$(mktemp 2>/dev/null || printf '%s\n' "${TMPDIR:-/tmp}/neutron-bun.$$")
  if bun install >"$_bun_log" 2>&1; then
    spin_end 0 "dependencies installed"
    rm -f "$_bun_log"
  else
    spin_end 1
    cat "$_bun_log" >&2
    rm -f "$_bun_log"
    die "bun install failed"
  fi
else
  bun install || die "bun install failed"
fi

# Install GBrain — Neutron's real memory substrate — so a fresh self-host ships
# with knowledge-graph + semantic recall instead of silently degrading to
# on-disk entity pages. Non-fatal + opt-out aware (see ensure_gbrain).
ensure_gbrain

# ── config ───────────────────────────────────────────────────────────────────
ui_phase "2/6" "Configuration"

# ── .env (never clobber an existing one) ─────────────────────────────────────
if [ -f .env ]; then
  info ".env already exists — leaving it untouched"
elif [ -f .env.example ]; then
  cp .env.example .env
  info "wrote .env from .env.example (every value has a default; edit what you need)"
else
  warn ".env.example missing — skipping .env creation"
fi

# Pin a STABLE onboarding-chat cookie secret so the owner's logged-in session
# survives server restarts (open/server.ts otherwise mints an ephemeral secret
# each boot, silently logging the owner out). Idempotent across re-installs.
persist_cookie_secret "$SRC_DIR/.env"

# Persist the offsite backup remote (from --backup-remote or NEUTRON_BACKUP_REMOTE)
# so the scheduled backup timer pushes there. Without this the flag value was
# dropped and "offsite backup" never happened. The timer install below also
# passes NEUTRON_BACKUP_REMOTE through + bakes it into the generated unit.
if [ -n "$BACKUP_REMOTE" ]; then
  persist_env_var "$SRC_DIR/.env" NEUTRON_BACKUP_REMOTE "$BACKUP_REMOTE"
  info "pinned NEUTRON_BACKUP_REMOTE=$BACKUP_REMOTE in .env (offsite backup push enabled)"
fi

# ── migrations ───────────────────────────────────────────────────────────────
ui_phase "3/6" "Database"
# The server does NOT self-migrate on boot, so we migrate the exact DB it will
# open. Resolve that path the same way open/server.ts does — NEUTRON_DB_PATH
# (live env, then a .env pin) else <NEUTRON_HOME>/project.db — so a db pinned in
# .env migrates the file the server reads, not a stray default. We pass the
# resolved path explicitly; `bun run migrate` would resolve the same path on its
# own (migrations/runner.ts → resolveOpenDbPath), but an explicit arg keeps the
# installer in control of what it just printed and mkdir'd.
NEUTRON_HOME_RESOLVED=$(resolve_install_home "$SRC_DIR/.env")
# Move an old flat-layout install's DB into the nested data dir BEFORE we pin /
# migrate, so a returning user's data follows them to the hardened layout.
migrate_flat_layout "$NEUTRON_HOME_RESOLVED"
mkdir -p "$NEUTRON_HOME_RESOLVED"
# Pin NEUTRON_HOME so the server (Bun auto-loads .env) opens exactly the data dir
# we just resolved + migrated. Without this a fresh .env copied from .env.example
# could point the server at a different (flat) dir than the installer migrated.
persist_env_var "$SRC_DIR/.env" NEUTRON_HOME "$NEUTRON_HOME_RESOLVED"
NEUTRON_DB_TARGET=$(resolve_db_target "$NEUTRON_HOME_RESOLVED" "$SRC_DIR/.env")
# Ensure the DB's parent dir exists (a custom NEUTRON_DB_PATH may live outside
# NEUTRON_HOME); the runner creates the file but not its parent directory.
mkdir -p "$(dirname "$NEUTRON_DB_TARGET")"
spin_start "running database migrations"
# NEUTRON_MIGRATE_QUIET makes the runner emit one clean summary line
# (`✓ database ready (N migrations applied)`) instead of dumping the raw
# {"applied":[...]} JSON mid-install. Capture all output: on SUCCESS show only
# the summary (the last line) in the house style; on FAILURE print the full
# captured log so the error stays visible, then die. Standalone `bun run
# migrate` (flag unset) keeps the JSON output for debugging.
_migrate_log=$(mktemp 2>/dev/null || printf '%s\n' "${TMPDIR:-/tmp}/neutron-migrate.$$")
if NEUTRON_MIGRATE_QUIET=1 bun run migrate "$NEUTRON_DB_TARGET" >"$_migrate_log" 2>&1; then
  _mtail=$(tail -n 1 "$_migrate_log")
  # The quiet runner's summary already starts with "✓ "; strip it for the fancy
  # spinner (which adds its own ✓) so the line never double-checks. Plain mode
  # emits the runner's summary verbatim, exactly as the pre-theme installer did.
  spin_end 0 "${_mtail#✓ }"
  [ "$FANCY" = 1 ] || info "$_mtail"
  rm -f "$_migrate_log"
else
  spin_end 1
  cat "$_migrate_log" >&2
  rm -f "$_migrate_log"
  die "bun run migrate failed"
fi

# Now that .env exists + NEUTRON_HOME is pinned, resolve the port for the URL.
CHAT_PORT=$(resolve_port "$SRC_DIR/.env")

# ── Claude auth (detect / connect / guide) ───────────────────────────────────
ui_phase "4/6" "Claude auth"
# Mirror the Managed flow: subscription token via `claude setup-token` (browser
# OAuth) or an ANTHROPIC_API_KEY. Detects existing auth; on an interactive
# terminal it runs setup-token, CAPTURES the printed token, and persists it to
# .env; otherwise it prints exactly what to run and marks auth pending. It never
# reports auth complete unless a credential is actually present.
ensure_claude_auth
# HARD GATE (ISSUES #318): if auth never completed, flip APP_GATED_ON_AUTH and
# force start/open OFF so the service install, server start, and browser open all
# skip — the owner gets a clear "authenticate first" banner instead of a dead
# chat. MUST run before the service/start/open phases below.
apply_auth_gate
# If setup-token took over the terminal (interactive path), its onboarding noise
# scrolled the banner away. In FANCY mode on a real TTY, reclaim the screen and
# redraw the wordmark so phase 5/6 resumes on the Neutron logo. No-op otherwise.
ui_reclaim_after_auth

# ── system service (boot + crash-restart supervisor) ─────────────────────────
# Detects the OS and installs a launchd LaunchAgent (macOS) / systemd user unit
# (Linux) that boots Neutron at login and respawns it on crash — the self-host
# a boot + crash-restart service supervisor. --no-service opts out.
#
# SERVICE_INSTALLED is set to 1 ONLY when neutron-service.sh actually loaded +
# STARTED the unit (it now verifies via `launchctl print` / `systemctl --user
# is-active` and returns non-zero on real failure). A common headless-Linux case
# — no per-user D-Bus session — fails here; we must NOT claim the service is
# running. On failure we leave SERVICE_INSTALLED=0 so the start block below falls
# back to a foreground/nohup background start (an honest "running"), never a lie.
ui_phase "5/6" "Service & autostart"
SERVICE_INSTALLED=0
if [ "$APP_GATED_ON_AUTH" = 1 ]; then
  # Auth gate (ISSUES #318): installing the service would RunAtLoad-start the
  # server (launchd/systemd), landing the owner in a credential-less dead chat —
  # the exact thing the gate prevents. Hold off until Claude is authenticated.
  warn "holding off on the boot service + autostart until Claude is authenticated"
elif [ "$DO_SERVICE" = 1 ]; then
  if [ -f "$SRC_DIR/neutron-service.sh" ]; then
    spin_start "installing the boot + crash-restart service"
    if [ "$FANCY" = 1 ]; then
      # Fancy: capture the helper's own output behind the spinner; surface it
      # only when the install actually fails.
      _svc_log=$(mktemp 2>/dev/null || printf '%s\n' "${TMPDIR:-/tmp}/neutron-svc.$$")
      if NEUTRON_SERVICE_CODE_DIR="$SRC_DIR" NEUTRON_HOME="$NEUTRON_HOME_RESOLVED" NEUTRON_PORT="$CHAT_PORT" \
           sh "$SRC_DIR/neutron-service.sh" install >"$_svc_log" 2>&1; then
        SERVICE_INSTALLED=1
        spin_end 0 "service installed — boots at login, restarts on crash"
      else
        spin_end 1
        cat "$_svc_log" >&2
        if [ "$DO_START" = 1 ]; then
          warn "service install failed — falling back to a background start (see logs above)"
        else
          warn "service install failed — start manually with: cd $SRC_DIR && bun run start"
        fi
      fi
      rm -f "$_svc_log"
    else
      # Plain: stream the helper's output exactly as the pre-theme installer did.
      if NEUTRON_SERVICE_CODE_DIR="$SRC_DIR" NEUTRON_HOME="$NEUTRON_HOME_RESOLVED" NEUTRON_PORT="$CHAT_PORT" \
           sh "$SRC_DIR/neutron-service.sh" install; then
        SERVICE_INSTALLED=1
      elif [ "$DO_START" = 1 ]; then
        warn "service install failed — falling back to a background start (see logs below)"
      else
        warn "service install failed — start manually with: cd $SRC_DIR && bun run start"
      fi
    fi
  else
    warn "neutron-service.sh missing beside the checkout — skipping service install"
  fi
fi

# ── git data-backups (deterministic, no-LLM) ─────────────────────────────────
# Schedule a launchd StartInterval / systemd timer that git-commits the data dir
# on NEUTRON_BACKUP_INTERVAL (default 12h); pushes to NEUTRON_BACKUP_REMOTE when
# set. --no-backup opts out.
if [ "$DO_BACKUP" = 1 ]; then
  if [ -f "$SRC_DIR/neutron-backup.sh" ]; then
    NEUTRON_SERVICE_CODE_DIR="$SRC_DIR" NEUTRON_HOME="$NEUTRON_HOME_RESOLVED" \
      NEUTRON_BACKUP_REMOTE="$BACKUP_REMOTE" \
      sh "$SRC_DIR/neutron-backup.sh" install-timer \
      || warn "backup timer install failed — run '$SRC_DIR/neutron-backup.sh run' from cron instead"
  else
    warn "neutron-backup.sh missing beside the checkout — skipping backup scheduling"
  fi
fi

# ── gbrain memory auto-upgrade + doctor (the cc-update-doctor analogue) ───────
# Schedule a launchd StartInterval / systemd timer that runs `neutron doctor
# --upgrade` daily: re-install gbrain when upstream advances (idempotent + safe,
# pinned to the resolved commit) AND VERIFY it still works (binary on PATH,
# responds, real memory round-trip — not just "binary exists"). Out-of-process
# by design: Neutron NEVER auto-upgrades GBrain inside a running instance
# (gbrain-memory/version-notice.ts). Only when gbrain actually installed; the
# --no-gbrain opt-out skips it. Best-effort + non-fatal — a scheduling failure
# never aborts the install (the doctor stays runnable via `neutron doctor`).
if [ "$DO_GBRAIN" = 1 ] && [ "$GBRAIN_INSTALLED" = 1 ]; then
  if [ -f "$SRC_DIR/neutron-service.sh" ]; then
    NEUTRON_SERVICE_CODE_DIR="$SRC_DIR" NEUTRON_HOME="$NEUTRON_HOME_RESOLVED" \
      sh "$SRC_DIR/neutron-service.sh" install-doctor \
      || warn "gbrain doctor schedule failed — run '$SRC_DIR/bin/neutron doctor --upgrade' on a cron instead"
  fi
fi

# ── neutron CLI on PATH ──────────────────────────────────────────────────────
install_neutron_cli

CHAT_URL="http://127.0.0.1:$CHAT_PORT/chat"

# ── start the server now (unless --no-start) ─────────────────────────────────
if [ "$DO_START" = 1 ]; then
  if [ "$SERVICE_INSTALLED" = 1 ]; then
    # The service's RunAtLoad already started it; nudge once more idempotently so
    # a reinstall-over-running picks up fresh code.
    sh "$SRC_DIR/neutron-service.sh" start >/dev/null 2>&1 || true
  else
    # No service (--no-service or install failed): detached background start,
    # recording the pid at $NEUTRON_HOME/neutron.pid so uninstall.sh stops it.
    # We exec the entrypoint DIRECTLY (`bun run open/server.ts`) rather than the
    # `bun run start` alias: the alias forks a child, so `$!` would capture the
    # PARENT (cmdline lacks the open/server.ts token uninstall.sh matches on).
    mkdir -p "$NEUTRON_HOME_RESOLVED/logs"
    PIDFILE="$NEUTRON_HOME_RESOLVED/neutron.pid"
    LOGFILE="$NEUTRON_HOME_RESOLVED/logs/server.log"
    info "starting the server in the background (logs: $LOGFILE)"
    nohup bun run open/server.ts >"$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
  fi
  # Open the browser on macOS — interactive terminals only (never on a piped
  # curl | sh), and skippable with --no-open.
  if [ "$DO_OPEN" = 1 ] && [ "$(uname -s 2>/dev/null)" = Darwin ] && [ -t 1 ] \
       && command -v open >/dev/null 2>&1; then
    open "$CHAT_URL" >/dev/null 2>&1 || true
  fi
fi

# ── final banner — ends with the working URL, never a "now run X" ────────────
# Fancy mode renders a left-gutter "you're live" panel; plain mode prints the
# exact pre-theme lines (the contract the install tests assert against). Both
# carry the same facts (state, code/data dirs, control hint, URL, auth-pending
# next-steps) and honor CLAUDE_AUTH_PENDING / SERVICE_INSTALLED / DO_START.
printf '\n'
if [ "$FANCY" = 1 ]; then
  ui_phase "6/6" "Ready"
  if [ "$CLAUDE_AUTH_PENDING" = 1 ]; then
    _hl="NEUTRON INSTALLED — ONE STEP LEFT"; _hc="$C_WARN"
  elif [ "$DO_START" = 1 ]; then
    _hl="NEUTRON IS LIVE"; _hc="$C_OK"
  else
    _hl="NEUTRON IS READY"; _hc="$C_OK"
  fi
  _g="${C_BRAND2}│${C_RESET}"
  printf '\n  %s╭─%s %s%s%s %s──────────────────────────────%s\n' \
    "$C_BRAND2" "$C_RESET" "$C_BOLD$_hc" "$_hl" "$C_RESET" "$C_BRAND2$C_DIM" "$C_RESET"
  printf '  %s\n' "$_g"
  if [ "$APP_GATED_ON_AUTH" = 1 ]; then
    # ISSUES #318: gated on auth — NOT started, NO open URL. The chat would be
    # unusable without a Claude credential, so we never present one here.
    printf '  %s  %sStatus%s   %snot started — authenticate Claude first (below)%s\n' \
      "$_g" "$C_MUTE" "$C_RESET" "$C_WARN" "$C_RESET"
  elif [ "$DO_START" = 1 ]; then
    printf '  %s  %sOpen%s     %s%s%s\n' "$_g" "$C_MUTE" "$C_RESET" "$C_ACCENT$C_BOLD" "$CHAT_URL" "$C_RESET"
  else
    printf '  %s  %sStart%s    %sneutron start%s   %s(or: cd %s && bun run start)%s\n' \
      "$_g" "$C_MUTE" "$C_RESET" "$C_ACCENT" "$C_RESET" "$C_DIM" "$SRC_DIR" "$C_RESET"
    printf '  %s  %sThen%s     %s%s%s\n' "$_g" "$C_MUTE" "$C_RESET" "$C_ACCENT$C_BOLD" "$CHAT_URL" "$C_RESET"
  fi
  if [ "$SERVICE_INSTALLED" = 1 ]; then
    printf '  %s  %sControl%s  %sneutron%s %sstart · stop · restart · status · logs%s\n' \
      "$_g" "$C_MUTE" "$C_RESET" "$C_BRAND" "$C_RESET" "$C_DIM" "$C_RESET"
  fi
  printf '  %s  %sCode%s     %s%s%s\n' "$_g" "$C_MUTE" "$C_RESET" "$C_DIM" "$SRC_DIR" "$C_RESET"
  printf '  %s  %sData%s     %s%s%s\n' "$_g" "$C_MUTE" "$C_RESET" "$C_DIM" "$NEUTRON_HOME_RESOLVED" "$C_RESET"
  if [ "$GBRAIN_INSTALLED" = 1 ]; then
    printf '  %s  %sMemory%s   %sGBrain installed — knowledge-graph + semantic recall ON%s\n' \
      "$_g" "$C_MUTE" "$C_RESET" "$C_DIM" "$C_RESET"
  else
    printf '  %s  %sMemory%s   %sDEGRADED — entity pages on disk only (run: bun install -g %s)%s\n' \
      "$_g" "$C_MUTE" "$C_RESET" "$C_WARN" "$GBRAIN_REF" "$C_RESET"
  fi
  if [ "$CLAUDE_AUTH_PENDING" = 1 ]; then
    printf '  %s\n' "$_g"
    printf '  %s  %sAuthenticate Claude, then start Neutron:%s\n' "$_g" "$C_WARN" "$C_RESET"
    printf '  %s    %sclaude setup-token%s  %s→ add CLAUDE_CODE_OAUTH_TOKEN=… to %s/.env%s\n' \
      "$_g" "$C_ACCENT" "$C_RESET" "$C_DIM" "$SRC_DIR" "$C_RESET"
    printf '  %s    %sor%s set %sANTHROPIC_API_KEY=sk-ant-…%s in %s/.env\n' \
      "$_g" "$C_DIM" "$C_RESET" "$C_ACCENT" "$C_RESET" "$SRC_DIR"
    # The gate SKIPPED the service install, so `neutron start` alone would die
    # (no plist to kickstart). `neutron install` writes the unit AND starts the
    # server, which now passes the app gate with the freshly-added token
    # (ISSUES #318, Argus BLOCKING). Foreground fallback if launchd is unhappy.
    printf '  %s    %sthen%s %sneutron install%s   %s→ installs + starts → %s%s\n' \
      "$_g" "$C_DIM" "$C_RESET" "$C_ACCENT" "$C_RESET" "$C_DIM" "$CHAT_URL" "$C_RESET"
    printf '  %s         %sor foreground:%s %scd %s && bun run start%s\n' \
      "$_g" "$C_DIM" "$C_RESET" "$C_ACCENT" "$SRC_DIR" "$C_RESET"
  fi
  printf '  %s\n' "$_g"
  if [ "$APP_GATED_ON_AUTH" = 1 ]; then
    printf '  %s╰─%s %s▸ Authenticate Claude (above), then start Neutron to open chat.%s\n\n' \
      "$C_BRAND2" "$C_RESET" "$C_ACCENT" "$C_RESET"
  else
    printf '  %s╰─%s %s▸ Open the URL above to start orchestrating your Claude Code sessions.%s\n\n' \
      "$C_BRAND2" "$C_RESET" "$C_ACCENT" "$C_RESET"
  fi
else
  if [ "$CLAUDE_AUTH_PENDING" = 1 ]; then
    info "install complete — but Claude auth is STILL REQUIRED before first chat."
  else
    info "install complete."
  fi
  printf '  code:    %s\n' "$SRC_DIR"
  printf '  data:    %s\n' "$NEUTRON_HOME_RESOLVED"
  if [ "$GBRAIN_INSTALLED" = 1 ]; then
    printf '  memory:  GBrain installed (knowledge-graph + semantic recall enabled)\n'
  else
    printf '  memory:  DEGRADED — entity pages on disk only; enable with: bun install -g %s\n' "$GBRAIN_REF"
  fi
  if [ "$SERVICE_INSTALLED" = 1 ]; then
    printf '  service: installed (boots at login, restarts on crash)\n'
    printf '  control: neutron start | stop | restart | status | logs\n'
  fi
  printf '\n'

  # When auth is still pending the box is GATED (ISSUES #318): we did NOT start
  # the server or install the service, because a chat with no Claude credential is
  # unusable. Restate the exact next action so the user does not scroll back.
  if [ "$CLAUDE_AUTH_PENDING" = 1 ]; then
    info "Neutron is NOT started yet — authenticate Claude first with EITHER:"
    printf '    claude setup-token   # then add the printed CLAUDE_CODE_OAUTH_TOKEN=… to %s/.env\n' "$SRC_DIR"
    printf '    or set ANTHROPIC_API_KEY=sk-ant-… in %s/.env\n' "$SRC_DIR"
    # The gate SKIPPED the service install, so `neutron start` would die (no unit
    # to kickstart). `neutron install` writes the unit AND starts it; foreground
    # `bun run start` is the fallback (ISSUES #318, Argus BLOCKING).
    printf '    then: neutron install   # installs the service + starts (or foreground: cd %s && bun run start)\n' "$SRC_DIR"
    printf '    open: %s\n' "$CHAT_URL"
    printf '\n'
  elif [ "$DO_START" = 1 ]; then
    info "Neutron is running."
    printf '  Open Neutron:  %s\n' "$CHAT_URL"
    printf '\n'
  else
    printf '  Start Neutron:  neutron start    (or: cd %s && bun run start)\n' "$SRC_DIR"
    printf '  Then open:      %s\n' "$CHAT_URL"
    printf '\n'
  fi
fi
