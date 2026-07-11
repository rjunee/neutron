#!/bin/sh
#
# neutron-backup.sh — deterministic, NO-LLM git backup of the Neutron data dir.
#
# Mirrors openclaw's vault-backup pattern: `git init` the data dir if needed,
# then auto-commit it on a schedule. If a remote is configured
# (NEUTRON_BACKUP_REMOTE), also `git push` for offsite backup; with no remote
# the local git history alone is fully recoverable.
#
# The backup is wired as a launchd StartInterval agent (macOS) / systemd timer
# (Linux) rather than through the in-process CronJobRegistry: that registry is
# rebuilt at server boot from open/composer.ts and cannot be injected into from
# an installer shell script without editing the composer. A timer is the
# spec-sanctioned fallback ("if cron-job registration from the installer is not
# clean, fall back to a launchd/systemd timer") and is itself deterministic +
# LLM-free.
#
# Subcommands:
#   run             do one backup pass (init → add → commit → optional push)
#   install-timer   write + load the periodic backup timer
#   uninstall-timer stop + remove the timer
#   print           write the resolved timer file to stdout (test seam)
#
# SECRETS-AT-REST (S3a): the backup deliberately EXCLUDES `.neutron-aes-key`
# (`.gitignore`'d — see `write_gitignore` / `ensure_gitignore_excludes_key`),
# even though it lives inside NEUTRON_HOME next to `project.db`. `project.db`
# holds AES-256-GCM CIPHERTEXT (`auth/secrets-store.ts`); shipping the key
# alongside it to the backup remote would make that ciphertext trivially
# decryptable by anyone with read access to the remote — encryption-at-rest
# in name only. There is no `restore` subcommand here (restore is: clone/pull
# the backup remote into a fresh NEUTRON_HOME, then start the server) — and
# because the key is excluded, that restore does NOT recover the ability to
# decrypt pre-existing secrets by itself. The key must be provisioned
# separately (copy it from the original machine, or from wherever you store
# it out-of-band) BEFORE starting a restored server. If it's missing,
# `SecretsStore` (`auth/secrets-store.ts:ensureKey`) now fails loud at
# construction — rather than silently minting a fresh key that can never
# decrypt the restored rows — whenever the restored `secrets` table already
# has data but no keyfile is present.
#
# Resolution (env overridable):
#   NEUTRON_SERVICE_CODE_DIR  code dir (default: this script's dir) — for .env
#   NEUTRON_HOME              data dir to back up (default: <code>/.env, else $HOME/neutron/data)
#   NEUTRON_BACKUP_REMOTE     git remote URL for offsite push (default: none → local-only)
#   NEUTRON_BACKUP_INTERVAL   seconds between backups (default: 43200 = 12h)
#   NEUTRON_SERVICE_OS        force darwin|linux (default: `uname -s`) — test seam
#   NEUTRON_SERVICE_LAUNCHCTL launchctl command (default: launchctl) — test seam
#   NEUTRON_SERVICE_SYSTEMCTL systemctl command (default: systemctl) — test seam
#   NEUTRON_BACKUP_SELF       path to this script (default: resolved) — for the timer
#
# POSIX sh — no bashisms.

set -eu

LABEL=neutron-backup

info() { printf 'neutron-backup: %s\n' "$*"; }
warn() { printf 'neutron-backup: WARNING: %s\n' "$*" >&2; }
die()  { printf 'neutron-backup: ERROR: %s\n' "$*" >&2; exit 1; }

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

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SELF=${NEUTRON_BACKUP_SELF:-$SCRIPT_DIR/neutron-backup.sh}
CODE_DIR=${NEUTRON_SERVICE_CODE_DIR:-$SCRIPT_DIR}
ENVFILE="$CODE_DIR/.env"

DATA_DIR=${NEUTRON_HOME:-}
[ -n "$DATA_DIR" ] || DATA_DIR=$(_dotenv_get "$ENVFILE" NEUTRON_HOME)
[ -n "$DATA_DIR" ] || DATA_DIR="$HOME/neutron/data"

REMOTE=${NEUTRON_BACKUP_REMOTE:-}
[ -n "$REMOTE" ] || REMOTE=$(_dotenv_get "$ENVFILE" NEUTRON_BACKUP_REMOTE)

INTERVAL=${NEUTRON_BACKUP_INTERVAL:-}
[ -n "$INTERVAL" ] || INTERVAL=$(_dotenv_get "$ENVFILE" NEUTRON_BACKUP_INTERVAL)
[ -n "$INTERVAL" ] || INTERVAL=43200

OS=${NEUTRON_SERVICE_OS:-}
[ -n "$OS" ] || case "$(uname -s 2>/dev/null || echo unknown)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *)      OS=unknown ;;
esac

PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$UNIT_DIR/$LABEL.service"
TIMER_PATH="$UNIT_DIR/$LABEL.timer"
LAUNCHCTL=${NEUTRON_SERVICE_LAUNCHCTL:-launchctl}
SYSTEMCTL=${NEUTRON_SERVICE_SYSTEMCTL:-systemctl}
LOG_FILE="$DATA_DIR/logs/backup.log"

# ── the backup operation ─────────────────────────────────────────────────────
# Fold any WAL-resident commits into the main .db file BEFORE we snapshot it.
# The schema runs in WAL mode (PRAGMA journal_mode = WAL, migrations/0001), so a
# backup taken WHILE the server is live can find recently-committed rows sitting
# in the gitignored `-wal` sidecar and NOT yet in the main `.db` file — a naive
# `git add` of the .db would silently miss them (or capture a torn image). A
# TRUNCATE checkpoint flushes every committed WAL frame into the main .db file and
# empties the WAL, so the committed .db is complete + internally coherent; ongoing
# server writes then accumulate in a fresh WAL while the main file stays stable for
# git to read. Best-effort + non-fatal: a non-SQLite `.db`, or a missing sqlite3
# CLI, is committed as-is (with a warning) rather than aborting the whole backup.
checkpoint_sqlite_dbs() {
  for _db in "$DATA_DIR"/*.db; do
    [ -f "$_db" ] || continue          # no-match glob, or a stray non-file
    # Header sniff: only run sqlite3 on real SQLite files (the magic is the 16
    # bytes "SQLite format 3\0"), so a non-DB `.db` is left untouched.
    case "$(head -c 16 "$_db" 2>/dev/null || true)" in
      "SQLite format 3"*) : ;;
      *) continue ;;
    esac
    if command -v sqlite3 >/dev/null 2>&1; then
      if sqlite3 "$_db" 'PRAGMA wal_checkpoint(TRUNCATE);' >/dev/null 2>&1; then
        info "checkpointed WAL → $(basename "$_db") (coherent snapshot)"
      else
        warn "wal checkpoint failed for $_db — committing it as-is (may miss WAL-resident rows)"
      fi
    elif [ -f "$_db-wal" ] && [ -s "$_db-wal" ]; then
      warn "sqlite3 not found — cannot fold $(basename "$_db")'s WAL into a single-file snapshot."
      warn "  Install sqlite3 for WAL-coherent backups, or stop the server before backing up."
    fi
  done
}

# Volatile files we never want in the backup history: logs, pidfiles, and the
# SQLite WAL/SHM sidecars (transient; the committed project.db — made coherent by
# checkpoint_sqlite_dbs above — is the recoverable snapshot).
#
# S3(a) — CRITICAL: `.neutron-aes-key` (the AES-256-GCM key that decrypts every
# row in the `secrets` table, `auth/secrets-store.ts`) MUST NEVER be committed
# here. `project.db` (the ciphertext) is exactly what this backup is FOR, but
# bundling the key alongside it would hand anyone with read access to the
# backup remote both the lock and the key — encryption-at-rest in name only.
# The key stays local-only; see `do_run`'s restore note below for what that
# means for restore. Written once on init, but the exclusion patterns are
# also RE-ASSERTED on every `run` (see `ensure_gitignore_excludes_key` below)
# so an existing install's `.gitignore` — written before this fix — still
# gets the key pattern appended, and so a key file already staged/tracked
# from a prior (pre-fix) run gets un-staged/un-tracked before the commit.
write_gitignore() {
  _gi="$DATA_DIR/.gitignore"
  [ -f "$_gi" ] && return 0
  cat > "$_gi" <<'GI'
# Neutron data backup — exclude volatile runtime files.
logs/
*.log
*.pid
*-wal
*-shm

# S3(a) — NEVER back up the AES key that decrypts project.db's secrets table.
# The backup must contain only ciphertext; the key stays local-only.
.neutron-aes-key
GI
}

# Self-heal an existing `.gitignore` (written by a pre-S3 install) that
# predates the `.neutron-aes-key` exclusion, and un-track the key if a prior
# (pre-fix) run already committed it into THIS local backup repo. Idempotent;
# safe to run every `do_run` pass. Does NOT rewrite git history — a key
# committed before this fix landed is still recoverable from old commits on
# whatever remote it was pushed to; rotate it if that remote was untrusted.
#
# S3(a) — FAIL CLOSED. The `git rm --cached` is not trusted blindly: an index
# lock / perms error / any git failure could leave the key STILL tracked, and
# committing/pushing then would re-leak it. So the AUTHORITATIVE gate is a
# post-removal `git ls-files` VERIFY — if the key is still in the index we
# `die` BEFORE `do_run` ever reaches `git add`/commit/push. The commit/push
# only proceeds once the key is verified absent from the index.
ensure_gitignore_excludes_key() {
  _gi="$DATA_DIR/.gitignore"
  if [ -f "$_gi" ] && ! grep -qxF '.neutron-aes-key' "$_gi" 2>/dev/null; then
    printf '\n# S3(a) — NEVER back up the AES key that decrypts project.db'"'"'s secrets table.\n.neutron-aes-key\n' >> "$_gi"
    info "hardened $_gi — added .neutron-aes-key exclusion (pre-existing install)"
  fi
  # Only act if the key is actually TRACKED in this backup repo's index.
  git ls-files --error-unmatch .neutron-aes-key >/dev/null 2>&1 || return 0
  # Attempt to untrack it (index only — never deletes the local keyfile). Do
  # NOT claim success from the exit code here; the verify below is authoritative.
  if ! git rm -q --cached .neutron-aes-key >/dev/null 2>&1; then
    warn "git rm --cached .neutron-aes-key failed — verifying the index before any commit/push"
  fi
  # AUTHORITATIVE gate: refuse to proceed while the key is still in the index.
  if git ls-files --error-unmatch .neutron-aes-key >/dev/null 2>&1; then
    die "refusing to back up: .neutron-aes-key is STILL tracked in the backup repo after attempting to untrack it (git index locked / permissions?). Committing or pushing now would leak the AES key. Aborting before add/commit/push — resolve the git state (e.g. remove .git/index.lock) and re-run."
  fi
  info "untracked .neutron-aes-key from the backup repo — excluded from all future commits (local keyfile left intact)."
  warn "  It may STILL exist in OLDER commits; the pre-push history gate purges those before any push."
}

# Set to 1 by `purge_key_from_history` when it rewrites history, so the push
# uses `--force` (rewriting changes every commit's SHA).
HISTORY_REWRITTEN=0

# Is a git subcommand available? A subcommand `git-<name>` lives either on PATH
# (filter-repo installs itself there) or inside `git --exec-path` (built-ins
# like filter-branch). Checking both is more reliable than probing `git <name>`.
_git_subcmd_available() {
  command -v "git-$1" >/dev/null 2>&1 && return 0
  [ -n "${1:-}" ] && [ -e "$(git --exec-path 2>/dev/null)/git-$1" ] && return 0
  return 1
}

# TRUE when `.neutron-aes-key` is reachable ANYWHERE in history — either a
# reachable commit touched the path, or a reachable object is that blob. Both
# dimensions are checked so a rename/gc quirk can't hide it.
key_reachable_in_history() {
  [ -n "$(git log --all --pretty=format:%H -- .neutron-aes-key 2>/dev/null)" ] && return 0
  git rev-list --all --objects 2>/dev/null | grep -qF ' .neutron-aes-key' && return 0
  return 1
}

# S3(a) — the key must NEVER be reachable in anything we PUSH. The index gates
# keep it out of the CURRENT commit, but a user who ran an OLDER backup version
# (which committed the key) still has it in reachable HISTORY, and the first
# push to a newly configured remote would disclose it. So BEFORE any push we
# DETECT the key in this LOCAL repo's history and, if present, PURGE it from all
# LOCAL commits (this is a dedicated backup repo — rewriting its history to
# remove a leaked secret is correct and expected), then VERIFY the local history
# is clean. If we cannot purge or verify, we FAIL CLOSED (die) rather than push
# a history that still contains the key. Only the key PATH is rewritten;
# project.db + unrelated history are untouched. (The REMOTE side — including any
# pre-existing remote tag/branch this tool did not create — is verified
# separately AFTER the push by `verify_remote_clean_after_push`.)
purge_key_from_history() {
  git rev-parse HEAD >/dev/null 2>&1 || return 0   # no commits yet → nothing to purge
  key_reachable_in_history || return 0             # not in history → nothing to do

  warn ".neutron-aes-key is present in this backup repo's LOCAL history — purging it from all local commits before push."
  if _git_subcmd_available filter-repo; then
    git filter-repo --path .neutron-aes-key --invert-paths --force >/dev/null 2>&1 \
      || die "refusing to push: 'git filter-repo' failed to purge .neutron-aes-key from history. Run it by hand in $DATA_DIR, then re-run:  git filter-repo --path .neutron-aes-key --invert-paths --force"
  elif _git_subcmd_available filter-branch; then
    FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force \
      --index-filter 'git rm --cached --ignore-unmatch .neutron-aes-key' \
      --prune-empty -- --all >/dev/null 2>&1 \
      || die "refusing to push: 'git filter-branch' failed to purge .neutron-aes-key from history. Run it by hand in $DATA_DIR (see below), then re-run:  FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force --index-filter 'git rm --cached --ignore-unmatch .neutron-aes-key' --prune-empty -- --all"
    # filter-branch keeps the pre-rewrite refs under refs/original/; drop them,
    # expire the reflogs, and gc so the key blob becomes truly unreachable.
    git for-each-ref --format='%(refname)' refs/original/ 2>/dev/null \
      | while IFS= read -r _ref; do [ -n "$_ref" ] && git update-ref -d "$_ref" 2>/dev/null || true; done
    git reflog expire --expire=now --all >/dev/null 2>&1 || true
    git gc --prune=now >/dev/null 2>&1 || true
  else
    die "refusing to push: .neutron-aes-key is in this backup repo's history and neither 'git filter-repo' nor 'git filter-branch' is available to purge it. Install git-filter-repo, then in $DATA_DIR run:  git filter-repo --path .neutron-aes-key --invert-paths --force  — and re-run the backup. (The push is BLOCKED until the key is purged so it can never reach the remote.)"
  fi
  HISTORY_REWRITTEN=1
  # AUTHORITATIVE post-purge verify — never assume the rewrite worked.
  if key_reachable_in_history; then
    die "refusing to push: .neutron-aes-key is STILL reachable in history after the purge attempt. Aborting before push to avoid disclosing the key — purge it manually in $DATA_DIR and re-run."
  fi
  info "purged .neutron-aes-key from all local backup history (local keyfile left intact)."
}

# Delete the temp verification namespace so a fetched (possibly key-carrying)
# remote ref never lingers to pollute the local `--all` history checks.
_cleanup_remote_verify_refs() {
  git for-each-ref --format='%(refname)' refs/remote-verify/ 2>/dev/null \
    | while IFS= read -r _r; do [ -n "$_r" ] && git update-ref -d "$_r" 2>/dev/null || true; done
}

# S3(a) — the AUTHORITATIVE post-push gate. The local purge + force-push clean
# the branch this tool OWNS, but they cannot reach a key sitting on a
# PRE-EXISTING remote tag or a second branch the tool never created. So AFTER
# pushing we fetch EVERY remote ref into a temp namespace and verify the key is
# reachable from NONE of them. If any remote ref still carries it, we FAIL
# CLOSED (die) naming the exact ref(s) + the commands to sanitize them, rather
# than falsely report the backup clean. (neutron-backup is a single-branch
# snapshot tool that never creates tags/other branches, so this only triggers
# on an exotic remote seeded outside the tool — but the guarantee is honest.)
verify_remote_clean_after_push() {
  if ! git fetch -q origin '+refs/*:refs/remote-verify/*' 2>/dev/null; then
    _cleanup_remote_verify_refs
    die "refusing to report the backup clean: could not fetch $REMOTE refs to verify .neutron-aes-key is absent from every remote ref. Verify the remote manually before trusting this backup."
  fi
  _bad_refs=""
  for _vref in $(git for-each-ref --format='%(refname)' refs/remote-verify/ 2>/dev/null); do
    if [ -n "$(git log "$_vref" --pretty=format:%H -- .neutron-aes-key 2>/dev/null)" ]; then
      _bad_refs="$_bad_refs refs/${_vref#refs/remote-verify/}"
    fi
  done
  # Object-level belt-and-suspenders across all fetched refs (catches a blob
  # reachable even where a path-filtered log might not surface it).
  _allv=$(git for-each-ref --format='%(refname)' refs/remote-verify/ 2>/dev/null)
  if [ -n "$_allv" ] && git rev-list --objects $_allv 2>/dev/null | grep -qF ' .neutron-aes-key'; then
    case "$_bad_refs" in
      *refs/*) : ;;                                  # already named a ref
      *) _bad_refs="$_bad_refs (a reachable object on the remote)" ;;
    esac
  fi
  _cleanup_remote_verify_refs
  if [ -n "$_bad_refs" ]; then
    die "refusing to report the backup clean: .neutron-aes-key is STILL retrievable from $REMOTE on ref(s):$_bad_refs. This tool rewrote + force-pushed the branch it owns, but it does NOT own the ref(s) above. Sanitize them, e.g.:  git push $REMOTE --delete <branch>   (for a tag:  git push $REMOTE :refs/tags/<name>), or re-initialize the backup remote. The key remains DISCLOSED on the remote until you do."
  fi
  info "verified $REMOTE carries .neutron-aes-key on NO ref."
}

do_run() {
  [ -d "$DATA_DIR" ] || die "data dir does not exist: $DATA_DIR"
  command -v git >/dev/null 2>&1 || die "git is required for backups — install git"
  cd "$DATA_DIR" || die "could not enter $DATA_DIR"

  if [ ! -d "$DATA_DIR/.git" ]; then
    info "initializing git backup repo in $DATA_DIR"
    git init -q
    # Identity for unattended commits (only if the user has none configured).
    git config user.email  >/dev/null 2>&1 || git config user.email "neutron-backup@localhost"
    git config user.name   >/dev/null 2>&1 || git config user.name  "Neutron Backup"
  fi
  write_gitignore
  ensure_gitignore_excludes_key
  # Coherent snapshot first (fold WAL into the main .db), THEN stage + commit.
  checkpoint_sqlite_dbs

  git add -A

  # S3(a) — THE AUTHORITATIVE key-exclusion gate. The pre-emptive .gitignore
  # write + `ensure_gitignore_excludes_key` are defense-in-depth, but neither
  # is decisive: Git applies the LAST matching ignore rule, so a NEGATED pair
  # (`.neutron-aes-key` then `!.neutron-aes-key`) leaves the key UN-ignored and
  # `git add -A` above will have STAGED it — and a stray `git add -f`, a config
  # quirk, or any other path could stage it too. So right here, after staging
  # and BEFORE any commit/push, we (1) actively un-stage the key (corrects a
  # negated rule) and (2) VERIFY it is absent from the index — dying loudly if
  # it is still there, no matter WHY. This is the single chokepoint that makes
  # "the backup never contains the AES key" true independent of gitignore-rule
  # complexity.
  git rm --cached --ignore-unmatch -q -- .neutron-aes-key >/dev/null 2>&1 || true
  if git ls-files --error-unmatch -- .neutron-aes-key >/dev/null 2>&1; then
    die "refusing to back up: .neutron-aes-key is STAGED in the index at commit time (a negated .gitignore rule / forced add?). Committing or pushing now would leak the AES key. Aborting before commit/push — remove any '!.neutron-aes-key' negation from $DATA_DIR/.gitignore and re-run."
  fi

  if git diff --cached --quiet 2>/dev/null; then
    info "no changes to back up"
  else
    _ts=$(date +"%Y-%m-%d %H:%M:%S %Z" 2>/dev/null || echo backup)
    git commit -q -m "neutron backup: $_ts" || true
    info "committed backup ($_ts)"
  fi

  # Offsite push only when a remote is configured. Local history alone is
  # already fully recoverable, so a push failure must never lose the commit.
  if [ -n "$REMOTE" ]; then
    # S3(a) — purge the key from ALL reachable history BEFORE it can reach the
    # remote (handles legacy repos that committed it under an older backup
    # version), then run the AUTHORITATIVE pre-push gate: never push a history
    # that still contains the key. Both steps fail closed (die) on any doubt.
    purge_key_from_history
    if key_reachable_in_history; then
      die "refusing to push: .neutron-aes-key is reachable in history at push time. Aborting so the key can never reach $REMOTE — purge it (git filter-repo --path .neutron-aes-key --invert-paths --force in $DATA_DIR) and re-run."
    fi

    if git remote get-url origin >/dev/null 2>&1; then
      git remote set-url origin "$REMOTE"
    else
      git remote add origin "$REMOTE"
    fi
    _branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)
    # Push comprehensively for what this tool OWNS: force ALL local heads (a
    # rewrite changed every SHA, so force is required; this is a dedicated
    # backup remote, so force is safe + intended) and PRUNE remote branches the
    # local no longer has, then sync any local tags. We drive it off the local
    # ref globs rather than hard-coding the single branch, so an unexpected
    # local ref still syncs instead of being silently missed.
    if git push -q --force --prune origin 'refs/heads/*:refs/heads/*' 2>/dev/null; then
      git push -q --force --tags origin 2>/dev/null || true
      if [ "$HISTORY_REWRITTEN" = 1 ]; then
        info "force-pushed purged history to $REMOTE ($_branch)"
      else
        info "pushed to $REMOTE ($_branch)"
      fi
      # AUTHORITATIVE post-push gate: verify the REMOTE carries the key on NO
      # ref (branch OR tag), including refs this tool did not create. Fails
      # closed with remediation if any remote ref still has it.
      verify_remote_clean_after_push
    else
      warn "git push to $REMOTE failed — local commit preserved, will retry next run"
    fi
  fi
}

# ── timer generators ─────────────────────────────────────────────────────────
# Emit the launchd <key>/<string> pair for NEUTRON_BACKUP_REMOTE — but ONLY when
# a remote is configured, so the unset case bakes nothing and `do_run` falls back
# to the .env lookup. Tab-indented to match the surrounding plist dict.
_plist_remote_env() {
  [ -n "$REMOTE" ] || return 0
  printf '\t\t<key>NEUTRON_BACKUP_REMOTE</key>\n\t\t<string>%s</string>' "$REMOTE"
}

# Emit a systemd `Environment=NEUTRON_BACKUP_REMOTE=…` line — only when a remote
# is configured (else nothing, and `do_run` reads it from .env).
_unit_remote_env() {
  [ -n "$REMOTE" ] || return 0
  printf 'Environment=NEUTRON_BACKUP_REMOTE=%s' "$REMOTE"
}

# launchd StartInterval agent — runs `neutron-backup.sh run` every INTERVAL
# seconds (and once at load). When a backup remote is configured it is baked into
# EnvironmentVariables so the scheduled push targets it directly.
generate_plist() {
  _remote_env=$(_plist_remote_env)
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>$SELF</string>
		<string>run</string>
	</array>
	<key>StartInterval</key>
	<integer>$INTERVAL</integer>
	<key>RunAtLoad</key>
	<true/>
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
		<key>NEUTRON_SERVICE_CODE_DIR</key>
		<string>$CODE_DIR</string>
$_remote_env
		<key>PATH</key>
		<string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
	</dict>
</dict>
</plist>
PLIST
}

# systemd user service + timer pair. OnUnitActiveSec drives the interval;
# OnBootSec gives a first run shortly after login.
generate_service() {
  _remote_env=$(_unit_remote_env)
  cat <<UNIT
[Unit]
Description=Neutron (Open) data backup

[Service]
Type=oneshot
Environment=NEUTRON_HOME=$DATA_DIR
Environment=NEUTRON_SERVICE_CODE_DIR=$CODE_DIR
$_remote_env
ExecStart=/bin/sh $SELF run
UNIT
}

generate_timer() {
  cat <<TIMER
[Unit]
Description=Neutron (Open) data backup — every ${INTERVAL}s

[Timer]
OnBootSec=120
OnUnitActiveSec=${INTERVAL}
Persistent=true

[Install]
WantedBy=timers.target
TIMER
}

# ── timer lifecycle ──────────────────────────────────────────────────────────
do_install_timer() {
  mkdir -p "$DATA_DIR/logs"
  case "$OS" in
    darwin)
      mkdir -p "$(dirname "$PLIST_PATH")"
      generate_plist > "$PLIST_PATH"
      info "wrote backup agent → $PLIST_PATH (every ${INTERVAL}s)"
      _domain="gui/$(id -u)"
      "$LAUNCHCTL" bootout "$_domain/$LABEL" >/dev/null 2>&1 || true
      "$LAUNCHCTL" bootstrap "$_domain" "$PLIST_PATH" 2>/dev/null \
        || "$LAUNCHCTL" load -w "$PLIST_PATH" 2>/dev/null || true
      info "backup agent loaded ($LABEL)"
      ;;
    linux)
      mkdir -p "$UNIT_DIR"
      generate_service > "$SERVICE_PATH"
      generate_timer > "$TIMER_PATH"
      info "wrote backup service + timer → $TIMER_PATH (every ${INTERVAL}s)"
      "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
      "$SYSTEMCTL" --user enable --now "$LABEL.timer" >/dev/null 2>&1 \
        || warn "systemctl --user enable failed — is a user session/bus available? (try: loginctl enable-linger $USER)"
      info "backup timer enabled ($LABEL)"
      ;;
    *)
      warn "unsupported OS for the backup timer — run '$SELF run' from your own cron instead"
      ;;
  esac
}

do_uninstall_timer() {
  case "$OS" in
    darwin)
      "$LAUNCHCTL" bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 \
        || "$LAUNCHCTL" unload -w "$PLIST_PATH" >/dev/null 2>&1 || true
      [ -f "$PLIST_PATH" ] && { rm -f "$PLIST_PATH"; info "removed $PLIST_PATH"; } || true
      ;;
    linux)
      "$SYSTEMCTL" --user disable --now "$LABEL.timer" >/dev/null 2>&1 || true
      [ -f "$TIMER_PATH" ] && { rm -f "$TIMER_PATH"; info "removed $TIMER_PATH"; } || true
      [ -f "$SERVICE_PATH" ] && rm -f "$SERVICE_PATH" || true
      "$SYSTEMCTL" --user daemon-reload >/dev/null 2>&1 || true
      ;;
    *) : ;;
  esac
}

do_print() {
  case "$OS" in
    darwin) generate_plist ;;
    linux)  generate_timer ;;
    *) die "unsupported OS for print" ;;
  esac
}

# ── dispatch ─────────────────────────────────────────────────────────────────
cmd=${1:-}
case "$cmd" in
  run)             do_run ;;
  install-timer)   do_install_timer ;;
  uninstall-timer) do_uninstall_timer ;;
  print)           do_print ;;
  ""|--help|-h)
    printf 'usage: neutron-backup.sh {run|install-timer|uninstall-timer|print}\n' ;;
  *) die "unknown command: $cmd (try --help)" ;;
esac
