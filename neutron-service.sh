#!/bin/sh
#
# neutron-service.sh — install / control the Neutron (Open) single-owner server
# as a boot + crash-restart supervised system service.
#
# A launchd (macOS) / systemd (Linux) supervisor that keeps the server running across boots + crashes:
# the server is NEVER intentionally down — it starts at login/boot and respawns
# on any crash. Cross-platform:
#   - macOS → a launchd LaunchAgent (~/Library/LaunchAgents/neutron-server.plist,
#             KeepAlive=true, RunAtLoad=true).
#   - Linux → a systemd USER unit (~/.config/systemd/user/neutron-server.service,
#             Restart=always, WantedBy=default.target).
#
# It is invoked by install.sh (`install`) + uninstall.sh (`uninstall`), and is
# the backend the `neutron` CLI (bin/neutron) drives for start|stop|status|
# restart|logs.
#
# Subcommands:
#   install      write + load the service, then start it now (boot supervisor)
#   uninstall    stop + unload + remove the service file
#   start        load/start the service
#   stop         stop the service (leaves it installed → still boots next login)
#   restart      restart the service
#   status       print whether the service is loaded/running
#   logs         tail the server log
#   print        write the resolved service file to stdout (no install; a seam
#                for tests + `neutron logs --unit`)
#
# Resolution (every value overridable by env, so install.sh can pin what it
# already resolved and the `neutron` CLI can re-resolve from the checkout):
#   NEUTRON_SERVICE_CODE_DIR  code dir (the checkout; default: this script's dir)
#   NEUTRON_HOME              data dir (default: <code>/.env pin, else $HOME/neutron/data)
#   NEUTRON_PORT              HTTP port (default: <code>/.env pin, else 7800)
#   BUN_BIN                   absolute bun path (default: `command -v bun`)
#   NEUTRON_SERVICE_OS        force darwin|linux (default: `uname -s`) — test seam
#   NEUTRON_SERVICE_LAUNCHCTL launchctl command (default: launchctl) — test seam
#   NEUTRON_SERVICE_SYSTEMCTL systemctl command (default: systemctl) — test seam
#
# POSIX sh — no bashisms.

set -eu

LABEL=neutron-server

info() { printf 'neutron-service: %s\n' "$*"; }
warn() { printf 'neutron-service: WARNING: %s\n' "$*" >&2; }
die()  { printf 'neutron-service: ERROR: %s\n' "$*" >&2; exit 1; }

# Minimal dotenv reader (last assignment wins; strips one quote pair; expands
# $HOME). Never execs the file. Mirrors install.sh's dotenv_get for the two
# values the service needs (NEUTRON_HOME, NEUTRON_PORT).
_dotenv_get() {
  _file=$1
  _key=$2
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

# ── resolve config ───────────────────────────────────────────────────────────
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CODE_DIR=${NEUTRON_SERVICE_CODE_DIR:-$SCRIPT_DIR}
ENVFILE="$CODE_DIR/.env"

DATA_DIR=${NEUTRON_HOME:-}
[ -n "$DATA_DIR" ] || DATA_DIR=$(_dotenv_get "$ENVFILE" NEUTRON_HOME)
[ -n "$DATA_DIR" ] || DATA_DIR="$HOME/neutron/data"

PORT=${NEUTRON_PORT:-}
[ -n "$PORT" ] || PORT=$(_dotenv_get "$ENVFILE" NEUTRON_PORT)
[ -n "$PORT" ] || PORT=7800

BUN_BIN=${BUN_BIN:-}
[ -n "$BUN_BIN" ] || BUN_BIN=$(command -v bun 2>/dev/null || true)

# The supervised server execs `claude` for EVERY CC-spawn LLM call, so the
# generated unit's PATH must contain the claude install dir. Resolve it here:
# the env override wins (so install.sh can pin what it already resolved + tests
# stay deterministic), else `command -v claude`. May be empty on a box where
# claude isn't installed yet — `_service_path` still bakes the guaranteed
# `$HOME/.local/bin` fallback (where claude.ai/install.sh symlinks `claude`).
CLAUDE_BIN=${NEUTRON_SERVICE_CLAUDE_BIN:-}
[ -n "$CLAUDE_BIN" ] || CLAUDE_BIN=$(command -v claude 2>/dev/null || true)

# Build the PATH baked into the launchd plist / systemd unit. launchd + systemd
# start with a minimal environment and no login shell, so the server only finds
# `bun` (it execs it) and `claude` (every CC-spawn LLM call execs it) if we set
# an explicit PATH. Entries, in priority order:
#   1. the resolved `claude` dir (dirname of CLAUDE_BIN) — so a non-default
#      install (Homebrew / vendored) is honored;
#   2. `$HOME/.local/bin` — the GUARANTEED fallback the official installer
#      (curl … claude.ai/install.sh) symlinks `claude` into;
#   3. the bun dir;
#   4. the standard system dirs (incl. Homebrew).
# Deduped (first occurrence wins) so re-running the installer regenerates a
# correct PATH without ever appending duplicates. Emitted via `_service_path`.
_service_path() {
  _claude_dir=""
  [ -n "$CLAUDE_BIN" ] && _claude_dir=$(dirname "$CLAUDE_BIN" 2>/dev/null || true)
  _bun_dir=""
  [ -n "$BUN_BIN" ] && _bun_dir=$(dirname "$BUN_BIN" 2>/dev/null || true)
  _out=""
  for _d in "$_claude_dir" "$HOME/.local/bin" "$_bun_dir" /opt/homebrew/bin /usr/local/bin /usr/bin /bin; do
    [ -n "$_d" ] || continue
    case ":$_out:" in
      *":$_d:"*) ;;                                # already present — dedup
      *) _out="${_out:+$_out:}$_d" ;;
    esac
  done
  printf '%s' "$_out"
}

LOG_DIR="$DATA_DIR/logs"
LOG_FILE="$LOG_DIR/server.log"

OS=${NEUTRON_SERVICE_OS:-}
[ -n "$OS" ] || case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *)      OS=unknown ;;
esac

PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$LABEL.service"
LAUNCHCTL=${NEUTRON_SERVICE_LAUNCHCTL:-launchctl}
SYSTEMCTL=${NEUTRON_SERVICE_SYSTEMCTL:-systemctl}

# GBrain memory auto-upgrade + doctor timer (the cc-update-doctor analogue,
# install-doctor/uninstall-doctor subcommands). A SEPARATE scheduled unit from
# the server: launchd runs `neutron doctor --upgrade` on a daily StartInterval;
# systemd a oneshot + daily timer. Out-of-process by design — Neutron NEVER
# auto-upgrades GBrain inside a running instance (gbrain-memory/version-notice.ts).
DOCTOR_LABEL=neutron-gbrain-doctor
DOCTOR_PLIST_PATH="$HOME/Library/LaunchAgents/$DOCTOR_LABEL.plist"
DOCTOR_UNIT_PATH="$UNIT_DIR/$DOCTOR_LABEL.service"
DOCTOR_TIMER_PATH="$UNIT_DIR/$DOCTOR_LABEL.timer"
DOCTOR_TS="$CODE_DIR/gbrain-memory/gbrain-doctor.ts"
# Cadence (seconds). Default daily; override for tests / faster cadences.
DOCTOR_INTERVAL=${NEUTRON_DOCTOR_INTERVAL:-86400}

# ── service-file generators ──────────────────────────────────────────────────
# launchd LaunchAgent plist. KeepAlive + RunAtLoad = boot + crash-restart. We
# run the entrypoint directly (`bun run open/server.ts`) from WorkingDirectory,
# so Bun auto-loads <code>/.env (where install.sh pinned NEUTRON_HOME). HOME +
# NEUTRON_HOME + PATH are set explicitly because launchd starts with a minimal
# environment and no login shell.
generate_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN_BIN</string>
		<string>run</string>
		<string>open/server.ts</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$CODE_DIR</string>
	<key>KeepAlive</key>
	<true/>
	<key>RunAtLoad</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>$LOG_FILE</string>
	<key>StandardErrorPath</key>
	<string>$LOG_FILE</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$HOME</string>
		<key>NEUTRON_HOME</key>
		<string>$DATA_DIR</string>
		<key>NEUTRON_PORT</key>
		<string>$PORT</string>
		<key>PATH</key>
		<string>$(_service_path)</string>
	</dict>
</dict>
</plist>
PLIST
}

# systemd user unit. Restart=always = crash-restart; WantedBy=default.target +
# `enable` = boot/login start. WorkingDirectory makes Bun auto-load <code>/.env.
generate_unit() {
  cat <<UNIT
[Unit]
Description=Neutron (Open) single-owner server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$CODE_DIR
ExecStart=$BUN_BIN run open/server.ts
Restart=always
RestartSec=5
Environment=NEUTRON_HOME=$DATA_DIR
Environment=NEUTRON_PORT=$PORT
Environment=PATH=$(_service_path)
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=default.target
UNIT
}

# ── gbrain doctor timer generators ─────────────────────────────────────────────
# launchd LaunchAgent that runs `neutron doctor --upgrade` every DOCTOR_INTERVAL
# seconds (StartInterval) plus once at load (RunAtLoad) so a fresh install is
# verified immediately. NOT KeepAlive — this is a periodic one-shot, not a daemon.
DOCTOR_LOG_FILE="$LOG_DIR/gbrain-doctor.log"
generate_doctor_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$DOCTOR_LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$BUN_BIN</string>
		<string>run</string>
		<string>$DOCTOR_TS</string>
		<string>upgrade</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$CODE_DIR</string>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>$DOCTOR_INTERVAL</integer>
	<key>StandardOutPath</key>
	<string>$DOCTOR_LOG_FILE</string>
	<key>StandardErrorPath</key>
	<string>$DOCTOR_LOG_FILE</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$HOME</string>
		<key>NEUTRON_HOME</key>
		<string>$DATA_DIR</string>
		<key>PATH</key>
		<string>$(_service_path)</string>
	</dict>
</dict>
</plist>
PLIST
}

# systemd oneshot service that runs one upgrade+verify pass.
generate_doctor_service() {
  cat <<UNIT
[Unit]
Description=Neutron GBrain memory auto-upgrade + doctor
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$CODE_DIR
ExecStart=$BUN_BIN run $DOCTOR_TS upgrade
Environment=NEUTRON_HOME=$DATA_DIR
Environment=PATH=$(_service_path)
StandardOutput=append:$DOCTOR_LOG_FILE
StandardError=append:$DOCTOR_LOG_FILE
UNIT
}

# systemd timer that fires the oneshot daily (Persistent catches up a missed
# run after the box was asleep — same posture as cc-update-doctor's cron).
generate_doctor_timer() {
  cat <<UNIT
[Unit]
Description=Schedule Neutron GBrain memory auto-upgrade + doctor

[Timer]
OnBootSec=5min
OnUnitActiveSec=${DOCTOR_INTERVAL}s
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

# ── restart health probe ─────────────────────────────────────────────────────
# Poll the server's /healthz on the CONFIGURED port until it answers or we time
# out. Used by do_restart to VERIFY the new process rebound the SAME port the
# owner's URL is pinned to (#314). The supervisors (launchd `kickstart -k`,
# systemd `restart`) already serialize old-exit-before-new-start; the server now
# additionally retries a transiently-busy configured port for ~8s before failing
# loud rather than silently moving to a random port — so a successful probe here
# confirms exactly one server is bound on $PORT. Best-effort: silently skips if
# curl is unavailable (the supervisor + server-side retry still hold the
# invariant; we just can't actively confirm it from the shell).
_wait_http_up() {
  _p=$1
  _timeout=${2:-15}
  command -v curl >/dev/null 2>&1 || return 0
  _i=0
  while [ "$_i" -lt "$_timeout" ]; do
    if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:$_p/healthz" 2>/dev/null; then
      return 0
    fi
    sleep 1
    _i=$((_i + 1))
  done
  return 1
}

# ── lifecycle ────────────────────────────────────────────────────────────────
do_install() {
  [ -n "$BUN_BIN" ] || die "bun not found — cannot write a service that execs it (set BUN_BIN or install bun)"
  mkdir -p "$LOG_DIR"
  case "$OS" in
    darwin)
      mkdir -p "$(dirname "$PLIST_PATH")"
      generate_plist > "$PLIST_PATH"
      info "wrote launchd agent → $PLIST_PATH"
      _domain="gui/$(id -u)"
      "$LAUNCHCTL" bootout "$_domain/$LABEL" >/dev/null 2>&1 || true
      "$LAUNCHCTL" bootstrap "$_domain" "$PLIST_PATH" 2>/dev/null \
        || "$LAUNCHCTL" load -w "$PLIST_PATH" 2>/dev/null || true
      "$LAUNCHCTL" enable "$_domain/$LABEL" >/dev/null 2>&1 || true
      "$LAUNCHCTL" kickstart -k "$_domain/$LABEL" >/dev/null 2>&1 || true
      # VERIFY the agent is actually loaded — `launchctl print` succeeds only when
      # the label exists in the domain. Without this the function would report
      # success even if every bootstrap/kickstart above failed, and install.sh
      # would then falsely claim "Neutron is running". On failure RETURN NON-ZERO
      # so the caller falls back to a manual/background start instead of lying.
      if "$LAUNCHCTL" print "$_domain/$LABEL" >/dev/null 2>&1; then
        info "launchd agent loaded ($LABEL) — boots at login, restarts on crash"
      else
        warn "launchd agent did not load ($LABEL) — check $LOG_FILE"
        die "service did not start ($LABEL) — caller should fall back to a manual start"
      fi
      ;;
    linux)
      mkdir -p "$UNIT_DIR"
      generate_unit > "$UNIT_PATH"
      info "wrote systemd user unit → $UNIT_PATH"
      "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
      # `enable --now` enables + starts in one shot; then VERIFY it is actually
      # active. The previous `|| warn` swallowed real failures and still returned
      # 0, so a headless box with no user D-Bus session (the common Linux self-host
      # case) printed "Neutron is running" when nothing started. Require BOTH the
      # enable AND a positive is-active before claiming success; otherwise RETURN
      # NON-ZERO so install.sh falls back to a background start.
      if "$SYSTEMCTL" --user enable --now "$LABEL.service" >/dev/null 2>&1 \
           && "$SYSTEMCTL" --user is-active "$LABEL.service" >/dev/null 2>&1; then
        info "systemd user unit enabled + active ($LABEL) — boots at login, restarts on crash"
      else
        warn "systemctl --user enable/start failed or unit not active — is a user session/bus available? (try: loginctl enable-linger ${USER:-$(id -un 2>/dev/null || echo you)})"
        die "service did not start ($LABEL) — caller should fall back to a manual start"
      fi
      ;;
    *)
      die "unsupported OS for service install ($(uname -s 2>/dev/null || echo unknown)) — use --no-service and start manually"
      ;;
  esac
}

do_uninstall() {
  case "$OS" in
    darwin)
      _domain="gui/$(id -u)"
      "$LAUNCHCTL" bootout "$_domain/$LABEL" >/dev/null 2>&1 \
        || "$LAUNCHCTL" unload -w "$PLIST_PATH" >/dev/null 2>&1 || true
      [ -f "$PLIST_PATH" ] && { rm -f "$PLIST_PATH"; info "removed $PLIST_PATH"; } || true
      ;;
    linux)
      "$SYSTEMCTL" --user disable --now "$LABEL.service" >/dev/null 2>&1 || true
      [ -f "$UNIT_PATH" ] && { rm -f "$UNIT_PATH"; info "removed $UNIT_PATH"; } || true
      "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
      ;;
    *) : ;;
  esac
}

do_start() {
  case "$OS" in
    darwin) "$LAUNCHCTL" kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null \
              || "$LAUNCHCTL" bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || die "could not start $LABEL — is it installed? (neutron install)" ;;
    linux)  "$SYSTEMCTL" --user start "$LABEL.service" || die "could not start $LABEL — is it installed?" ;;
    *) die "unsupported OS" ;;
  esac
  info "started ($LABEL)"
}

do_stop() {
  case "$OS" in
    darwin) "$LAUNCHCTL" kill SIGTERM "gui/$(id -u)/$LABEL" 2>/dev/null \
              || "$LAUNCHCTL" stop "$LABEL" 2>/dev/null || true ;;
    linux)  "$SYSTEMCTL" --user stop "$LABEL.service" || true ;;
    *) : ;;
  esac
  info "stopped ($LABEL)"
}

do_restart() {
  # Both supervisor primitives below stop the OLD instance and only then start
  # the NEW one (launchd `kickstart -k` kills the running instance before
  # respawning; systemd `restart` runs ExecStop → waits for exit → ExecStart) —
  # so there is never a two-servers-bound window from the supervisor's side. The
  # remaining socket-release overlap (old process draining 7800 while the new one
  # boots) is now ridden out by the server's deterministic bind-retry (#314), so
  # the new process rebinds the SAME configured port instead of moving to a
  # random one.
  case "$OS" in
    darwin) "$LAUNCHCTL" kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || die "restart failed — is it installed?" ;;
    linux)  "$SYSTEMCTL" --user restart "$LABEL.service" || die "restart failed" ;;
    *) die "unsupported OS" ;;
  esac
  # VERIFY the new process came back up on the CONFIGURED port — the whole point
  # of #314 is that a restart keeps the owner's bookmarked http://127.0.0.1:$PORT
  # working. Warn loudly (don't silently succeed) if nothing answers there.
  if _wait_http_up "$PORT" 15; then
    info "restarted ($LABEL) — listening on http://127.0.0.1:$PORT"
  else
    warn "restarted ($LABEL) but nothing answered on the configured port $PORT within 15s — check logs: $LOG_FILE"
    warn "the server retries a busy configured port for ~8s then FAILS LOUD (it will not silently bind a random port); if the old process is wedged, run: neutron stop && neutron start"
  fi
}

do_status() {
  case "$OS" in
    darwin) "$LAUNCHCTL" print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state =|pid =" || info "not loaded ($LABEL)" ;;
    linux)  "$SYSTEMCTL" --user status "$LABEL.service" 2>/dev/null || info "not loaded ($LABEL)" ;;
    *) info "unsupported OS for status" ;;
  esac
}

do_logs() {
  [ -f "$LOG_FILE" ] || { info "no log yet at $LOG_FILE"; return 0; }
  tail -n "${NEUTRON_LOG_LINES:-50}" -f "$LOG_FILE"
}

do_print() {
  case "$OS" in
    darwin) generate_plist ;;
    linux)  generate_unit ;;
    *) die "unsupported OS for print" ;;
  esac
}

# ── gbrain doctor: run + schedule install/uninstall ────────────────────────────
# Run one doctor pass NOW (verify, or verify+upgrade with --upgrade). Thin
# wrapper so `neutron-service.sh doctor` works standalone; bin/neutron drives it.
do_doctor() {
  [ -f "$DOCTOR_TS" ] || die "gbrain doctor helper missing at $DOCTOR_TS"
  [ -n "$BUN_BIN" ] || die "bun not found — cannot run the gbrain doctor (set BUN_BIN or install bun)"
  _sub=check
  [ "${1:-}" = "--upgrade" ] && _sub=upgrade
  exec "$BUN_BIN" run "$DOCTOR_TS" "$_sub"
}

# Install the scheduled doctor timer. Best-effort + non-fatal: a failure to
# schedule must never abort install.sh — the doctor is still runnable by hand
# (`neutron doctor --upgrade`). Mirrors do_install's load/verify shape.
do_install_doctor() {
  [ -n "$BUN_BIN" ] || { warn "bun not found — skipping gbrain doctor schedule (run 'neutron doctor --upgrade' manually)"; return 0; }
  mkdir -p "$LOG_DIR"
  case "$OS" in
    darwin)
      mkdir -p "$(dirname "$DOCTOR_PLIST_PATH")"
      generate_doctor_plist > "$DOCTOR_PLIST_PATH"
      info "wrote gbrain doctor agent → $DOCTOR_PLIST_PATH (runs every ${DOCTOR_INTERVAL}s)"
      _domain="gui/$(id -u)"
      "$LAUNCHCTL" bootout "$_domain/$DOCTOR_LABEL" >/dev/null 2>&1 || true
      "$LAUNCHCTL" bootstrap "$_domain" "$DOCTOR_PLIST_PATH" 2>/dev/null \
        || "$LAUNCHCTL" load -w "$DOCTOR_PLIST_PATH" 2>/dev/null || true
      "$LAUNCHCTL" enable "$_domain/$DOCTOR_LABEL" >/dev/null 2>&1 || true
      if "$LAUNCHCTL" print "$_domain/$DOCTOR_LABEL" >/dev/null 2>&1; then
        info "gbrain doctor scheduled ($DOCTOR_LABEL) — auto-upgrade + verify on a daily cadence"
      else
        warn "gbrain doctor agent did not load ($DOCTOR_LABEL) — run 'neutron doctor --upgrade' manually"
      fi
      ;;
    linux)
      mkdir -p "$UNIT_DIR"
      generate_doctor_service > "$DOCTOR_UNIT_PATH"
      generate_doctor_timer > "$DOCTOR_TIMER_PATH"
      info "wrote gbrain doctor unit + timer → $DOCTOR_TIMER_PATH (every ${DOCTOR_INTERVAL}s)"
      "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
      if "$SYSTEMCTL" --user enable --now "$DOCTOR_LABEL.timer" >/dev/null 2>&1; then
        info "gbrain doctor scheduled ($DOCTOR_LABEL.timer) — auto-upgrade + verify on a daily cadence"
      else
        warn "could not enable $DOCTOR_LABEL.timer (no user session/bus?) — run 'neutron doctor --upgrade' manually"
      fi
      ;;
    *)
      warn "unsupported OS for gbrain doctor schedule — run 'neutron doctor --upgrade' manually"
      ;;
  esac
  return 0
}

do_uninstall_doctor() {
  case "$OS" in
    darwin)
      _domain="gui/$(id -u)"
      "$LAUNCHCTL" bootout "$_domain/$DOCTOR_LABEL" >/dev/null 2>&1 \
        || "$LAUNCHCTL" unload -w "$DOCTOR_PLIST_PATH" >/dev/null 2>&1 || true
      [ -f "$DOCTOR_PLIST_PATH" ] && { rm -f "$DOCTOR_PLIST_PATH"; info "removed $DOCTOR_PLIST_PATH"; } || true
      ;;
    linux)
      "$SYSTEMCTL" --user disable --now "$DOCTOR_LABEL.timer" >/dev/null 2>&1 || true
      [ -f "$DOCTOR_TIMER_PATH" ] && { rm -f "$DOCTOR_TIMER_PATH"; info "removed $DOCTOR_TIMER_PATH"; } || true
      [ -f "$DOCTOR_UNIT_PATH" ] && { rm -f "$DOCTOR_UNIT_PATH"; info "removed $DOCTOR_UNIT_PATH"; } || true
      "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
      ;;
    *) : ;;
  esac
}

do_print_doctor() {
  case "$OS" in
    darwin) generate_doctor_plist ;;
    linux)  generate_doctor_service; printf -- '---\n'; generate_doctor_timer ;;
    *) die "unsupported OS for print-doctor" ;;
  esac
}

# ── dispatch ─────────────────────────────────────────────────────────────────
cmd=${1:-}
case "$cmd" in
  install)          do_install ;;
  uninstall)        do_uninstall ;;
  start)            do_start ;;
  stop)             do_stop ;;
  restart)          do_restart ;;
  status)           do_status ;;
  logs)             do_logs ;;
  print)            do_print ;;
  doctor)           shift; do_doctor "$@" ;;
  install-doctor)   do_install_doctor ;;
  uninstall-doctor) do_uninstall_doctor ;;
  print-doctor)     do_print_doctor ;;
  ""|--help|-h)
    printf 'usage: neutron-service.sh {install|uninstall|start|stop|restart|status|logs|print|doctor|install-doctor|uninstall-doctor|print-doctor}\n' ;;
  *) die "unknown command: $cmd (try --help)" ;;
esac
