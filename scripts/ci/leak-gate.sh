#!/usr/bin/env bash
#
# scripts/ci/leak-gate.sh — the PUBLIC Neutron Open purity gate.
#
# This is the ONLY leak gate that exists. There is no private carve-time gate and
# no Managed nightly backstop: `scripts/sprint-c/leak-gate.sh` (which this header
# claimed as the Tier-1 backstop until 2026-07-29) is NOT present in the Managed
# repo, and Managed's `.github/workflows/ci.yml` says in its own header that it
# runs no leak gate. That claim documented a control that had been silently
# decommissioned, which is how the Tier-1 rule below sat dead for ~3,700 CI runs
# without anyone noticing. If you are about to describe a backstop here, verify it
# exists first.
#
# WHAT IT SCANS
#   * the TREE at --tree <dir> (every file, not just tracked ones), and
#   * the COMMIT MESSAGES on this branch + the PR title/body, which the tree scan
#     cannot see. Those are mirrored permanently to GHArchive/BigQuery, where no
#     deletion is possible — prevention is the only control that exists for them,
#     so they are in scope. Pre-existing history is deliberately NOT scanned: it
#     is immutable and already mirrored, so flagging it would only produce a
#     permanently-red gate with no available remedy. The scan window is
#     `$LEAK_GATE_BASE_SHA..HEAD` (the workflow supplies the PR base / push
#     `before` sha), i.e. exactly the commits this change is adding.
#
# RULE TIERS
#   * Tier-1 PII  — owner proper nouns / private paths. The pattern source is
#                   SUPPLIED OUT-OF-BAND (`LEAK_GATE_PII_DENYLIST_B64` in CI, a
#                   local file outside the repo when run by hand — see "LOCAL
#                   DENYLIST") and is NEVER committed: a committed list would
#                   itself name the very strings it bans. It is therefore the one
#                   rule that can be absent, and absent means FAIL — see
#                   "FAIL-CLOSED" below.
#   * Tier-1 PATH — a STRUCTURAL companion that needs no secret: a tracked path
#                   may not carry a private-system token. Paths are public in the
#                   git tree regardless of file contents, so this rule still runs
#                   on a fork PR where the denylist is unavailable.
#   * Tier-2 PROSE— no "tenant"/"multi-tenant" notion in comments/docs.
#   * Tier-2 CODE — zero-tolerance over the live multi-tenant surface
#                   (tenant_slug / tenant_home / TenantDb / NEUTRON_TENANT_* /
#                   tenant_provisioned, cross-tenant, tenant-scoped provisioning).
#   * neutron.computer — zero-tolerance hosted-domain rule (self-host-only Open).
#   * Tier-3 STRUCTURAL — no Managed module dir, no tracked secret files, no
#                   Managed workspace name in the lockfile/manifests, real
#                   Apache-2.0 LICENSE, no NUL-hidden tokens.
#
# FAIL-CLOSED (2026-07-29). The Tier-1 rule used to print a WARNING, skip itself
# and still exit 0 "SILENT ✅" when the denylist was unset — which it always was,
# because no workflow ever passed the variable and the secret did not exist. A
# gate that reports success when its most important rule did not run is worse than
# no gate. Now: an absent or undecodable denylist is `exit 2` in any context that
# HAS access to repository secrets. The only skip is a `pull_request` from a FORK,
# where GitHub withholds secrets by design; the scheduled full scan
# (.github/workflows/leak-gate-nightly.yml) re-runs the same tree WITH the secret,
# so a fork PR merged on that skip is still caught. A run outside GitHub Actions
# is not a merge gate, so it cannot exit 2 — but it no longer prints a green
# verdict either: see "INCOMPLETE" below.
#
# LOCAL DENYLIST (2026-07-30). Because the denylist is a repository SECRET, an
# author working on their own machine had NO pre-push signal for the one class of
# leak that is unredactable once public — a commit message or PR body, mirrored
# to GHArchive/BigQuery within the hour. The first feedback arrived from CI,
# after the push. So the gate now also accepts the denylist from a file OUTSIDE
# the repository:
#
#     $LEAK_GATE_PII_DENYLIST_FILE                        (explicit override)
#     ${XDG_CONFIG_HOME:-$HOME/.config}/neutron/leak-gate-pii-denylist
#
# Plain text, same entry syntax as the base64 payload (it is the same list, just
# not base64-wrapped — the wrapping exists to survive a CI env var, not for
# secrecy: base64 is not encryption). Consulted ONLY outside GitHub Actions, and
# only when the env var is unset, so CI behaviour is bit-for-bit unchanged and a
# runner-side file can never stand in for the real secret. The file lives outside
# every working tree precisely so that no `git add` in any repo can ever pick it
# up. Once resolved it feeds the SAME `compile_denylist` + the SAME rules — there
# is no second matching implementation to drift.
#
# INCOMPLETE (2026-07-30). A run that could not load a denylist used to print
# "SILENT ✅" and exit 0, which is indistinguishable from "checked and clean" —
# the same shape of lie the 2026-07-29 fix removed from CI. Outside CI the
# verdict is now "INCOMPLETE" with exit 3, naming the rules that did not run. The
# fork-PR path inside CI is deliberately untouched (still exit 0, still covered by
# the nightly full scan) — changing it would fail every outside contributor's PR
# for a secret GitHub withholds by design.
#
# USAGE
#   scripts/ci/leak-gate.sh [dir]            # scan dir (default: .)
#   scripts/ci/leak-gate.sh --tree <dir>     # same; --tree accepted for parity
#   scripts/ci/leak-gate.sh --messages-only  # commit messages + PR title/body ONLY
#
# `--messages-only` exists for the pre-push hook (.githooks/pre-push). The full
# tree scan takes ~100 s on this repo, and a pre-push hook that costs 100 s is a
# hook that gets `--no-verify`'d — while the surface it would add is the one that
# CAN still be remediated (a bad tree is force-pushable and is blocked by CI
# before merge). Messages and PR bodies cannot be remediated at all, so that is
# what the hook checks, in about a second. The flag REFUSES to run inside GitHub
# Actions so it can never become a way to skip the tree scan in CI.
#
# ENVIRONMENT (the LEAK_GATE_* set is supplied by .github/workflows/ci.yml in CI,
# and by .githooks/pre-push locally)
#   LEAK_GATE_PII_DENYLIST_B64  base64 of the newline-separated denylist. Two
#                               entry kinds, documented at the compile step below.
#   LEAK_GATE_PII_DENYLIST_FILE path to a PLAIN-TEXT denylist. Non-CI only.
#   LEAK_GATE_PR_HEAD_REPO      head repo `owner/name` of a pull_request; used
#                               ONLY to detect the fork case.
#   LEAK_GATE_BASE_SHA          base commit for the message scan window.
#   LEAK_GATE_HEAD_SHA          tip of the message scan window (default: HEAD).
#                               The pre-push hook sets it to the sha it is about
#                               to publish, which is not always HEAD.
#   LEAK_GATE_PR_TITLE          PR title  (scanned; passed via env, never shell)
#   LEAK_GATE_PR_BODY           PR body   (scanned; passed via env, never shell)
#
# EXIT: 0 = silent (clean), 1 = findings, 2 = usage/config/internal error (which
# includes "a required rule could not run"), 3 = INCOMPLETE — nothing found, but a
# required rule could not run and this context is not allowed to exit 2. There is
# no skip flag and no env
# bypass; the only exception mechanism is the committed, reviewable allowlist
# (scripts/ci/leak-gate-allowlist.txt, `<path>:<rule-id>`), which is itself
# constrained — see the allowlist audit below.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWLIST_FILE="$HERE/leak-gate-allowlist.txt"
PROSE_AWK="$HERE/extract-comment-prose.awk"

SCAN_ROOT="."
MESSAGES_ONLY=0
# --explain-denylist: a DIAGNOSTIC, never a gate run. See the refusal below.
EXPLAIN_DENYLIST=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tree)
      [ $# -ge 2 ] || { echo "leak-gate: --tree requires a directory argument" >&2; exit 2; }
      SCAN_ROOT="$2"; shift 2 ;;
    --messages-only) MESSAGES_ONLY=1; shift ;;
    --explain-denylist) EXPLAIN_DENYLIST=1; shift ;;
    # Print the leading comment block. Derived, not a hardcoded line range: the
    # old `sed -n '2,74p'` silently truncated the moment the header grew.
    -h|--help)
      awk 'NR==1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    -*) echo "leak-gate: unknown argument '$1' (the gate is non-skippable)" >&2; exit 2 ;;
    *) SCAN_ROOT="$1"; shift ;;
  esac
done
SCAN_ROOT="$(cd "$SCAN_ROOT" && pwd)" || { echo "leak-gate: cannot cd to scan root" >&2; exit 2; }
[ -f "$PROSE_AWK" ] || { echo "leak-gate: missing $PROSE_AWK (prose extractor)" >&2; exit 2; }

FILELIST="$(mktemp)"; PROSE_VIEW="$(mktemp)"; MSG_VIEW="$(mktemp)"
trap 'rm -f "$FILELIST" "$PROSE_VIEW" "$MSG_VIEW"' EXIT

# ── Secret-access context ─────────────────────────────────────────────────────
# Derived from variables the GitHub runner sets, which a contributor cannot forge
# from inside a pull request. Three outcomes:
#   canonical — GitHub Actions on the base repo (push / schedule /
#               workflow_dispatch / merge_group / SAME-repo PR). Secrets are
#               available, so every rule MUST be able to run.
#   fork      — a pull_request whose head repo != GITHUB_REPOSITORY (which is
#               always the BASE repo). GitHub withholds secrets by design.
#   local     — not GitHub Actions at all.
# NOTE on the fork signal: a fork PR can only ever move ITSELF toward `canonical`
# (i.e. toward exit 2), never toward a skip it would not otherwise get, because it
# still cannot obtain the secret. A SAME-repo PR could in principle fake `fork` by
# editing the workflow — but that is a reviewable diff from a collaborator, and
# the nightly full scan re-checks the merged tree regardless.
IN_CI=0
if [ -n "${GITHUB_ACTIONS:-}" ] || [ -n "${GITHUB_RUN_ID:-}" ] || [ -n "${GITHUB_EVENT_NAME:-}" ]; then
  IN_CI=1
fi
SECRET_CONTEXT=local
if [ "$IN_CI" = "1" ]; then
  SECRET_CONTEXT=canonical
  case "${GITHUB_EVENT_NAME:-}" in
    pull_request|pull_request_target)
      if [ -n "${LEAK_GATE_PR_HEAD_REPO:-}" ] \
         && [ "${LEAK_GATE_PR_HEAD_REPO}" != "${GITHUB_REPOSITORY:-}" ]; then
        SECRET_CONTEXT=fork
      fi
      ;;
  esac
fi

# `--messages-only` is a PRE-PUSH mode, never a CI mode. Refusing it here is what
# stops it degrading into "the way to get the tree scan to stop failing": a
# workflow edit that passes the flag fails the job outright instead of quietly
# scanning a third of what it claims to.
if [ "$MESSAGES_ONLY" = "1" ] && [ "$IN_CI" = "1" ]; then
  echo "leak-gate: --messages-only is a pre-push mode and is REFUSED inside GitHub" >&2
  echo "           Actions. CI must run the full tree scan." >&2
  exit 2
fi

# `--explain-denylist` is a DIAGNOSTIC and is refused in CI for the same reason:
# it reports per-entry match counts instead of a verdict, so a workflow that
# invoked it would print a plausible-looking report and gate nothing.
if [ "$EXPLAIN_DENYLIST" = "1" ] && [ "$IN_CI" = "1" ]; then
  echo "leak-gate: --explain-denylist is a local diagnostic and is REFUSED inside" >&2
  echo "           GitHub Actions. CI must run the full tree scan." >&2
  exit 2
fi

# Rules that were REQUESTED but could not run, e.g. the PII denylist with no
# pattern source. Tracked so the verdict can distinguish "checked and clean" from
# "could not check" — the distinction whose absence let Tier-1 sit dead for
# ~3,700 CI runs.
UNRUN_RULES=""
note_unrun() { UNRUN_RULES="${UNRUN_RULES}${UNRUN_RULES:+, }$1"; }

# Every file in the tree is in scope.
(cd "$SCAN_ROOT" && find . -type f \
   -not -path './.git/*' \
   -not -path './node_modules/*' -not -path '*/node_modules/*' \
 | sed 's|^\./||') | sort -u > "$FILELIST"

TOTAL_FILES=$(wc -l < "$FILELIST" | tr -d ' ')
if [ "$TOTAL_FILES" = "0" ]; then
  echo "leak-gate: candidate file list is EMPTY — refusing to pass an empty scan" >&2
  exit 2
fi

# ── Allowlist ─────────────────────────────────────────────────────────────────
read_pathlist() { grep -vE '^[[:space:]]*(#|$)' "$1" | sed 's/[[:space:]]*$//'; }
ALLOW_GLOBS=(); ALLOW_RULES=()
if [ -f "$ALLOWLIST_FILE" ]; then
  while IFS= read -r line; do
    ALLOW_GLOBS+=("${line%:*}"); ALLOW_RULES+=("${line##*:}")
  done < <(read_pathlist "$ALLOWLIST_FILE")
fi
is_allowlisted() {
  local file="$1" rule="$2" i
  for i in "${!ALLOW_GLOBS[@]}"; do
    [ "${ALLOW_RULES[$i]}" = "$rule" ] || continue
    # shellcheck disable=SC2254
    case "$file" in ${ALLOW_GLOBS[$i]}) return 0 ;; esac
  done
  return 1
}

# ── Allowlist audit ───────────────────────────────────────────────────────────
# An allowlist entry is a permanent hole in a zero-tolerance gate, so the entry
# itself is gated. Before 2026-07-29 two directory globs (`migrations/*` and
# `docs/research/…-07-02/*`) exempted 155 files in order to cover 26 real ones —
# and, worse, pre-exempted every file added to those directories in future. PR
# #245's own commit message ("leak-gate allowlisted") is what a wide glob buys
# you. Three constraints, each independently fatal (exit 2, not a finding — a bad
# allowlist is a config error, and reporting it as a finding would let it be
# suppressed by another allowlist entry):
#   allowlist-dirglob  — an entry may not be a directory glob (`foo/*`, `*`).
#                        Name the files. A new file in that directory must be
#                        reviewed, not inherited.
#   allowlist-breadth  — no single entry may match more than 3 files.
#   allowlist-stale    — every entry must match at least 1 file. A stale entry is
#                        rot: it documents an exception that no longer exists and
#                        silently becomes wrong when a path is reused. Enforced
#                        ONLY when the allowlist OWNS the scanned tree (this
#                        script lives inside it). Pointed at a foreign tree — the
#                        self-test fixtures — every entry would trivially match
#                        nothing, and an inert entry there means nothing.
# Pseudo-paths used by the message scan (COMMIT-MESSAGE, PR-TITLE-BODY) can never
# be allowlisted, because they are not files and so can never satisfy
# allowlist-stale.
ALLOWLIST_MAX_FILES=3
# glob → ERE. Done in awk, not sed: a `[][...]` character class is accepted by
# GNU sed and rejected by BSD sed ("unbalanced brackets"), and this gate runs on
# both. `*` and `?` keep their glob meaning; everything else is literal.
glob_to_regex() {
  printf '%s\n' "$1" | awk '
    { out=""
      for (i=1;i<=length($0);i++) {
        c=substr($0,i,1)
        if (c=="*") out = out ".*"
        else if (c=="?") out = out "."
        else if (index("\\^$.[]|()+{}/", c)) out = out "\\" c
        else out = out c
      }
      print out }'
}
ALLOWLIST_OWNS_TREE=0
case "$HERE/" in "$SCAN_ROOT"/*) ALLOWLIST_OWNS_TREE=1 ;; esac
ALLOWLIST_ERRORS=""
for i in "${!ALLOW_GLOBS[@]}"; do
  ag="${ALLOW_GLOBS[$i]}"; ar="${ALLOW_RULES[$i]}"
  if [ -z "$ag" ] || [ -z "$ar" ]; then
    ALLOWLIST_ERRORS="${ALLOWLIST_ERRORS}  [allowlist-malformed] '${ag}:${ar}' — need <path>:<rule-id>\n"
    continue
  fi
  case "$ag" in
    '*'|*'/*')
      ALLOWLIST_ERRORS="${ALLOWLIST_ERRORS}  [allowlist-dirglob] '${ag}:${ar}' — directory globs are banned; list the exact paths\n"
      continue ;;
  esac
  an=$(grep -cE "^$(glob_to_regex "$ag")$" "$FILELIST" 2>/dev/null || true)
  an="${an:-0}"
  if [ "$an" -eq 0 ]; then
    [ "$ALLOWLIST_OWNS_TREE" = "1" ] || continue
    ALLOWLIST_ERRORS="${ALLOWLIST_ERRORS}  [allowlist-stale] '${ag}:${ar}' — matches no file in the scanned tree\n"
  elif [ "$an" -gt "$ALLOWLIST_MAX_FILES" ]; then
    ALLOWLIST_ERRORS="${ALLOWLIST_ERRORS}  [allowlist-breadth] '${ag}:${ar}' — matches ${an} files (max ${ALLOWLIST_MAX_FILES})\n"
  fi
done
if [ -n "$ALLOWLIST_ERRORS" ]; then
  echo "leak-gate: the ALLOWLIST is invalid — an exception must be narrow and live:" >&2
  printf '%b' "$ALLOWLIST_ERRORS" >&2
  exit 2
fi

# ── Finding accumulation ──────────────────────────────────────────────────────
TOTAL_FINDINGS=0; ALLOWLISTED_COUNT=0; SUMMARY=""; MAX_SHOWN_PER_RULE=5
report_hits() {
  local rule="$1" shown=0 count=0 hit file rest
  while IFS= read -r hit; do
    file="${hit%%:*}"; rest="${hit#*:}"
    if is_allowlisted "$file" "$rule"; then
      ALLOWLISTED_COUNT=$((ALLOWLISTED_COUNT + 1)); continue
    fi
    count=$((count + 1))
    if [ "$shown" -lt "$MAX_SHOWN_PER_RULE" ]; then
      printf '  [%s] %s:%s\n' "$rule" "$file" "$(printf '%s' "$rest" | cut -c1-160)"
      shown=$((shown + 1))
    fi
  done
  [ "$count" -gt "$shown" ] && printf '  [%s] … and %d more\n' "$rule" $((count - shown))
  if [ "$count" -gt 0 ]; then
    SUMMARY="${SUMMARY}    ${rule}: ${count}\n"; TOTAL_FINDINGS=$((TOTAL_FINDINGS + count))
  fi
}
run_grep() {
  local mode="$1" pattern="$2" flags='-EnHI'
  [ "$mode" = "ci" ] && flags='-EinHI'
  (cd "$SCAN_ROOT" && tr '\n' '\0' < "$FILELIST" | xargs -0 grep $flags -e "$pattern" 2>/dev/null) || true
}
grep_rule() { local rule="$1"; shift; report_hits "$rule" < <(run_grep "$@"); }

# ── Tier-2 prose view ─────────────────────────────────────────────────────────
# Skipped in --messages-only: this awk pass over every tracked file is a large
# share of the gate's runtime and nothing in the message scan reads PROSE_VIEW.
if [ "$MESSAGES_ONLY" = "0" ]; then
  (cd "$SCAN_ROOT" && tr '\n' '\0' < "$FILELIST" | xargs -0 awk -f "$PROSE_AWK" 2>/dev/null) > "$PROSE_VIEW" || true
fi
run_grep_prose() {
  local mode="$1" pattern="$2" strip="${3:-}"
  if [ "$mode" = "ci" ]; then
    pattern="$(printf '%s' "$pattern" | tr 'A-Z' 'a-z')"
    strip="$(printf '%s' "$strip" | tr 'A-Z' 'a-z')"
  fi
  awk -v pat="$pattern" -v strip="$strip" -v ci="$([ "$mode" = "ci" ] && echo 1 || echo 0)" '
    { text=$0; sub(/^[^:]*:[0-9]+:/,"",text); probe=text
      if (ci) probe=tolower(probe)
      if (strip!="") gsub(strip,"",probe)
      if (probe ~ pat) print $0 }' "$PROSE_VIEW" 2>/dev/null || true
}
grep_rule_prose() { local rule="$1"; shift; report_hits "$rule" < <(run_grep_prose "$@"); }

echo "leak-gate — scan root: $SCAN_ROOT"
echo "candidate files: $TOTAL_FILES"
echo "secret context: $SECRET_CONTEXT (event=${GITHUB_EVENT_NAME:-none})"
[ "$MESSAGES_ONLY" = "1" ] && echo "mode: --messages-only (commit messages + PR title/body; the TREE is NOT scanned)"
echo

if [ "$MESSAGES_ONLY" = "0" ]; then
# ── Tier 2: vocabulary ────────────────────────────────────────────────────────
echo "── Tier 2: multi-tenant vocabulary (prose + code) ─────────────────────"
grep_rule_prose tenant-word ci '(^|[^a-z0-9_])tenant(s|'\''s)?([^a-z0-9_]|$)' '[Cc]ross-?[Tt]enant'
grep_rule_prose tenant-docs ci 'P1-multi-tenant-base|tenant-boundary-spec'
grep_rule tenant-code       ci 'tenant_slug|tenant_home|tenant_id|TenantDb|NEUTRON_TENANT_|tenant_?provisioned'
grep_rule cross-tenant-code ci 'cross[-_]?tenant'
grep_rule provision-code    ci 'provision[_-]?tenant|per[_-]?tenant[_-]?provision|multi[_-]?tenant[_-]?provision|fleet[_-]?provision'
# camelCase multi-tenant ROUTING symbols the snake_case rules above miss.
# These two identifiers were the managed tenant→url_slug routing leak the audit
# found (2026-06-18); they were the FIRST to go and remain explicit tripwires.
grep_rule tenant-routing-camel cs 'mintStartTokenForTenant|startTokenSlugBelongsToTenant'

# ZERO-TOLERANCE broad tenant ban (build #3, 2026-06-19). The whole-engine
# tenant→owner rename is now COMPLETE — the public tree carries ZERO `tenant`
# anywhere in code (was ~870 refs: TenantsRegistry, tenantDataDir,
# resolveTenantSlug, PerTenantConcurrencyGate, TenantHandleResolver, …, all
# collapsed to the single-owner `owner*` vocabulary). So the old "narrow only,
# a broad rule would flag the engine" caveat no longer holds: any `tenant`
# substring re-entering the tree is now a regression. The ONLY legitimate
# residues are the word "Lieutenant" (a Star Trek character name in two UX
# tests) and the test query literal "xtenant-safety" — both carried in the
# allowlist by exact file. (Word-bounded so "maintenance" etc. never match.)
grep_rule tenant-purged ci '(^|[^a-z0-9_])tenant'

# Retired multi-tenant "workspace" identifiers (build #3). The connect/M2
# substrate still legitimately carries the persisted/wire `workspace` tokens
# (the membership-kind enum value 'workspace', the workspace_members table, the
# workspace_instance_slug / source_workspace_* columns, the workspace_unavailable
# API error code) — those are migration- + JWT-contract-bound and CANNOT be a
# blanket ban. So this is a NARROW tripwire over the exact non-contract
# identifiers that WERE renamed away (code-gen worktree, system-prompt
# context-files, the connect instance-registry helpers + env knob) so they
# can't silently regress. Also bans `workspace:` proto ONLY outside package
# manifests is NOT attempted — bun's `workspace:*` is package-manager tooling.
grep_rule workspace-retired cs 'WorkspaceRegistryRow|lookupWorkspace|workspaceCache|fromWorkspaces|syndicationRelayWorkspaceTemplate|NEUTRON_OPEN_WORKSPACE_BASE_URL|OPEN_WORKSPACE_BASE_URL_ENV|CodegenWorkspace|ResolveWorkspaceInput|ResolvedWorkspace|resolveWorkspace|PROJECT_WORKSPACE_DIRNAME|WORKSPACE_FILES|readOwnerWorkspaceFiles|workspace_path|workspace_file|workspace_not_resolved|workspace-resolver'

fi  # ── end tree-only rules (Tier 2) ──────────────────────────────────────────

# NOTE: the literal is SPLIT deliberately. bash concatenates adjacent quoted strings, so
# the runtime value is the real private token while the contiguous string never appears
# in this file — which both keeps the token out of the public tree AND stops the gate
# flagging itself. Do NOT "tidy" this into one quoted literal, and do NOT let a
# content scrub rewrite it: on 2026-07-29 a blanket scrub rewrote this value and the
# gate went green because the rule was searching for the wrong string.
# Defined OUTSIDE the --messages-only guard: the message rule `private-path-msg`
# below reads the same value, and duplicating it is how the two copies drift.
PRIVATE_PATH_RE='va''jra'

if [ "$MESSAGES_ONLY" = "0" ]; then
echo
# ── Tier 1 PATH (structural, zero secret): private tokens in tracked PATHS ────
# The denylist below needs a secret. This rule does not, because a PATH is public
# in the git tree no matter what the file contains — so it is the half of Tier-1
# that still runs on a fork PR, and it catches a whole directory of leakage with
# no pattern source at all. SUBSTRING match, case-insensitive, over the path: a
# private-system name concatenated into a longer segment must still trip.
echo "── Tier 1 (structural): private tokens in tracked paths ───────────────"
report_hits private-path < <(
  grep -iE "$PRIVATE_PATH_RE" "$FILELIST" \
    | sed 's|$|:1:tracked path carries a private-system token (rename the PATH — scrubbing file contents is not enough)|'
)
fi

echo
# ── Tier 1: owner PII denylist (supplied out-of-band — NEVER committed) ───────
# The public repo carries NO owner PII whatsoever — not in plaintext and not
# encoded (base64 is trivially reversible, so an embedded blob would itself be
# the leak). The denylist arrives via `LEAK_GATE_PII_DENYLIST_B64`: newline-
# separated entries, base64-encoded, set from a repository secret by the
# workflow. Blank lines and `#` comments are ignored. TWO ENTRY KINDS:
#
#   <token>          DEFAULT — case-INSENSITIVE SUBSTRING, separator-flexible.
#                    Use for anything path-like or identifier-like. The compiler
#                    below splits the entry on `/`, `-`, `_` and space and
#                    rejoins with `[/_ -]*`, so ONE entry `/home/alice` matches
#                    `/home/alice`, `-home-alice-` (the Claude project-dir form),
#                    `home_alice` and `HomeAlice`. This is the kind that was
#                    broken: the old rule was case-SENSITIVE and word-bounded, so
#                    a capitalised proper noun in the list could never match its
#                    lowercase path form, and `\b<token>\b` never matches a token
#                    concatenated into a camelCase identifier (both `openAlice`
#                    and `aliceImport` escape `\balice\b`).
#
#   word:<token>     Case-SENSITIVE and word-bounded. Use ONLY for a proper noun
#                    that is also an ordinary English word or a common substring,
#                    where the default kind would false-positive on prose. This
#                    is the narrow exception, not the default — if unsure, don't.
#
# Word-bounding is expressed as `(^|[^A-Za-z0-9_])…([^A-Za-z0-9_]|$)` rather than
# `\b`, because the message scan runs through awk and BSD awk has no `\b`.
# A legitimate future collision is handled via the reviewable allowlist (rule ids
# pii-denylist / pii-denylist-word), same as every other rule.
compile_denylist() {
  # $1 = "sub" | "word"; reads the raw denylist on stdin, writes an alternation.
  awk -v kind="$1" '
    function esc(s,   out,i,c) {
      out=""
      for (i=1;i<=length(s);i++) {
        c=substr(s,i,1)
        if (index("\\^$.[]|()*+?{}/", c)) out = out "\\" c; else out = out c
      }
      return out
    }
    { line=$0
      sub(/^[ \t]+/,"",line); sub(/[ \t\r]+$/,"",line)
      if (line=="" || substr(line,1,1)=="#") next
      isword = (substr(line,1,5)=="word:")
      if (isword) line=substr(line,6)
      if (line=="") next
      if ((isword?1:0) != (kind=="word"?1:0)) next
      if (kind=="word") { printf "%s%s", (n++?"|":""), esc(line); next }
      gsub("^[/_ -]+","",line); gsub("[/_ -]+$","",line)
      m=split(line, parts, "[/_ -]+")
      pat=""
      for (i=1;i<=m;i++) { if (parts[i]=="") continue
        pat = pat (pat==""?"":"[/_ -]*") esc(parts[i]) }
      if (pat=="") next
      printf "%s%s", (n++?"|":""), pat }
    END { printf "\n" }'
}
echo "── Tier 1: owner PII denylist ─────────────────────────────────────────"
# SOURCE RESOLUTION — the only part of Tier-1 that differs between CI and a
# developer's machine. Everything downstream (compile_denylist, grep_rule,
# grep_rule_messages) is the SAME code for both, which is the point: a separate
# local implementation would drift and the local one would quietly stop matching.
#
# 1. `LEAK_GATE_PII_DENYLIST_B64` — the CI secret. Always wins.
# 2. a PLAIN-TEXT file outside the repo — consulted ONLY when (1) is unset AND
#    this is not GitHub Actions. Gating on `IN_CI` rather than on emptiness is
#    deliberate: it makes the CI path provably unchanged by this feature, and
#    stops a file planted on a runner from ever standing in for the real secret.
PII_SOURCE=none
PII_RAW="$(printf '%s' "${LEAK_GATE_PII_DENYLIST_B64:-}" | base64 -d 2>/dev/null || true)"
[ -n "$PII_RAW" ] && PII_SOURCE=env
if [ -z "$PII_RAW" ] && [ "$IN_CI" = "0" ]; then
  PII_FILE="${LEAK_GATE_PII_DENYLIST_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/neutron/leak-gate-pii-denylist}"
  if [ -f "$PII_FILE" ] && [ -r "$PII_FILE" ]; then
    PII_RAW="$(cat "$PII_FILE" 2>/dev/null || true)"
    # The PATH is safe to print (the operator chose it); the CONTENTS never are.
    if [ -n "$PII_RAW" ]; then
      PII_SOURCE="file:$PII_FILE"
    else
      echo "  denylist file is EMPTY: $PII_FILE" >&2
    fi
  else
    echo "  no denylist file at: $PII_FILE" >&2
  fi
fi
PII_SUB_ALT="$(printf '%s\n' "$PII_RAW" | compile_denylist sub)"
PII_WORD_ALT="$(printf '%s\n' "$PII_RAW" | compile_denylist word)"

# ── --explain-denylist ────────────────────────────────────────────────────────
# WHY THIS EXISTS (ISSUES #507). The denylist is a repository SECRET, so the local
# mirror at $HOME/.config/neutron/leak-gate-pii-denylist is maintained by hand and
# had drifted BROADER than the CI list: entries that CI carries as `word:` were
# plain substrings locally, so a surname entry matched inside the GitHub org/repo
# slug in the README and a whole-tree local run reported ~160 findings on files
# that are GREEN in CI. (Deliberately described, not quoted — a denylist term
# written into this tree is the very leak class the gate exists to stop, and this
# comment's first draft did exactly that. Its own --explain-denylist run caught
# it.)
#
# A gate that always fails is indistinguishable from a gate that found something,
# so the author learns to ignore it — and the one time it is right, it looks the
# same as the 160 times it was not. That is the permanently-red-check failure the
# CI-green rule exists to prevent, and it made the one pre-push signal for the one
# unredactable leak class (a commit message, mirrored to GHArchive within the hour)
# useless in practice.
#
# The fix is NOT to loosen matching — that would weaken a PII gate to reduce noise.
# It is to make the over-broad ENTRY identifiable, so "160 findings, ignore it"
# becomes "this one term produced 158 of them; prefix it with `word:`".
#
# Reuses the SAME resolved $PII_RAW and the SAME compile_denylist as the real
# rules, deliberately: the script's own contract is that there is no second
# matching implementation to drift.
if [ "$EXPLAIN_DENYLIST" = "1" ]; then
  if [ -z "$PII_RAW" ]; then
    echo "leak-gate --explain-denylist: no denylist resolved (source: ${PII_SOURCE})." >&2
    echo "  Put one at ${XDG_CONFIG_HOME:-$HOME/.config}/neutron/leak-gate-pii-denylist" >&2
    exit 2
  fi
  echo "leak-gate --explain-denylist  (source: ${PII_SOURCE}, tree: ${SCAN_ROOT})"
  echo "Per-entry match counts over the TRACKED tree (${TOTAL_FILES} files). A large"
  echo "count on a short or common term means that entry is over-broad as a substring"
  echo "— carry it as \`word:<term>\` so it only matches on token boundaries."
  echo ""
  printf '%8s  %-6s  %s\n' "MATCHES" "KIND" "ENTRY"
  # NOTE: prints the ENTRY, which is by definition owner PII. Correct here — this
  # mode is local-only (refused in CI above) and the operator already holds the
  # list. It must never be wired into a CI step.
  printf '%s\n' "$PII_RAW" | while IFS= read -r entry; do
    case "$entry" in ''|'#'*) continue ;; esac
    kind=sub; term="$entry"
    case "$entry" in word:*) kind=word; term="${entry#word:}" ;; esac
    esc="$(printf '%s' "$term" | sed 's/[][\\.^$*+?{}|()/]/\\\\&/g')"
    if [ "$kind" = word ]; then
      pat="(^|[^A-Za-z0-9_])${esc}([^A-Za-z0-9_]|$)"
    else
      pat="$esc"
    fi
    # MIRROR THE REAL RULES' CASE SEMANTICS. `pii-denylist` runs `ci`
    # (case-insensitive) and `pii-denylist-word` runs `cs` (case-SENSITIVE) — see
    # the grep_rule calls above. A diagnostic that folded case for both would
    # over-report word entries and send the operator chasing matches the gate
    # never makes, which is the same class of misleading signal this mode exists
    # to remove.
    if [ "$kind" = word ]; then ci_flag=""; else ci_flag="-i"; fi
    # Same traversal idiom as grep_rule: NUL-delimited, from the scan root.
    n=$( (cd "$SCAN_ROOT" && tr '\n' '\0' < "$FILELIST" | xargs -0 grep -a -c $ci_flag -E -e "$pat" 2>/dev/null) \
         | awk -F: '{ t += $NF } END { print t+0 }' )
    flag=""
    if [ "$kind" = sub ] && [ "${n:-0}" -gt 5 ]; then
      flag="   <-- over-broad as a substring? try  word:${term}"
    fi
    printf '%8s  %-6s  %s%s\n' "${n:-0}" "$kind" "$term" "$flag"
  done
  echo ""
  echo "This is a DIAGNOSTIC, not a gate run — it reports counts and never a verdict."
  echo "Exiting 2 on purpose so it can never be mistaken for a clean gate."
  exit 2
fi
if [ -n "$PII_SUB_ALT" ] || [ -n "$PII_WORD_ALT" ]; then
  echo "  denylist loaded from ${PII_SOURCE} (substring entries: $([ -n "$PII_SUB_ALT" ] && echo yes || echo no); word entries: $([ -n "$PII_WORD_ALT" ] && echo yes || echo no))"
  if [ "$MESSAGES_ONLY" = "0" ]; then
    [ -n "$PII_SUB_ALT" ]  && grep_rule pii-denylist      ci "(${PII_SUB_ALT})"
    [ -n "$PII_WORD_ALT" ] && grep_rule pii-denylist-word cs "(^|[^A-Za-z0-9_])(${PII_WORD_ALT})([^A-Za-z0-9_]|\$)"
  fi
elif [ "$SECRET_CONTEXT" = "canonical" ]; then
  cat >&2 <<'EOF'
leak-gate: FATAL — LEAK_GATE_PII_DENYLIST_B64 is unset, empty or undecodable, but
this run HAS access to repository secrets, so the Tier-1 PII rule MUST run. A run
that skips it and still reports success is exactly the failure this gate exists
to prevent (it did so on every CI run up to 2026-07-29).

Fix BOTH halves — either alone is theatre:
  * set the `LEAK_GATE_PII_DENYLIST_B64` repository secret, and
  * pass it into the job's `env:` (see .github/workflows/ci.yml — the secret
    existing is not enough; nothing delivers it unless the workflow says so).
EOF
  exit 2
elif [ "$SECRET_CONTEXT" = "fork" ]; then
  echo "leak-gate: Tier-1 PII denylist SKIPPED — context 'fork' has no access to" >&2
  echo "           repository secrets. This is the ONLY sanctioned skip. The scheduled full" >&2
  echo "           scan (leak-gate-nightly.yml) re-runs this tree WITH the denylist." >&2
else
  # LOCAL, no denylist. Not a merge gate, so not exit 2 — but emphatically not a
  # pass either. This is the case that has to stay LOUD: it is the state every
  # developer machine was in, and the silent version of it is why an author had
  # no signal before publishing a commit message they could never take back.
  note_unrun "pii-denylist, pii-denylist-msg"
  cat >&2 <<EOF
leak-gate: Tier-1 PII COULD NOT RUN — no denylist available in this context.
           This run does NOT tell you the tree or the messages are clean of owner
           PII; it tells you nothing about them at all.

           To arm it locally, put the plain-text denylist at
             ${LEAK_GATE_PII_DENYLIST_FILE:-${XDG_CONFIG_HOME:-\$HOME/.config}/neutron/leak-gate-pii-denylist}
           (outside every working tree, so no \`git add\` can ever reach it), then
           run \`bash scripts/install-git-hooks.sh\` to arm the pre-push hook.
EOF
fi

if [ "$MESSAGES_ONLY" = "0" ]; then
echo
# ── Tier 1 (shape-only, zero PII): hosted-domain rule ─────────────────────────
echo "── hosted-domain (self-host-only Open) ────────────────────────────────"
grep_rule neutron-computer ci 'neutron\.computer'
fi

echo
# ── Commit messages + PR title/body ───────────────────────────────────────────
# The tree scan can never see these, and they are the one surface with NO
# remediation: GHArchive/BigQuery mirror every public commit message and PR body
# within the hour, permanently. Prevention is the entire control.
echo "── commit messages + PR title/body ────────────────────────────────────"
build_message_view() {
  : > "$MSG_VIEW"
  git -C "$SCAN_ROOT" rev-parse --git-dir >/dev/null 2>&1 || return 1
  local base="" cand
  if [ -n "${LEAK_GATE_BASE_SHA:-}" ]; then
    case "${LEAK_GATE_BASE_SHA}" in
      0000000*) ;;                                   # push that created the ref
      *) if git -C "$SCAN_ROOT" cat-file -e "${LEAK_GATE_BASE_SHA}^{commit}" 2>/dev/null; then
           base="${LEAK_GATE_BASE_SHA}"
         fi ;;
    esac
  fi
  if [ -z "$base" ]; then
    for cand in "origin/${GITHUB_BASE_REF:-}" origin/main main; do
      case "$cand" in 'origin/') continue ;; esac
      if git -C "$SCAN_ROOT" rev-parse --verify -q "$cand" >/dev/null 2>&1; then base="$cand"; break; fi
    done
  fi
  [ -n "$base" ] || return 1
  # The TIP of the window. Defaults to HEAD, which is right for CI and for a
  # plain `git push`. The pre-push hook overrides it with the exact sha git is
  # about to publish, which is NOT always HEAD — `git push origin <sha>:main` and
  # a push from a detached or non-current branch both publish something else, and
  # scanning HEAD there would check commits that are not being pushed while
  # missing the ones that are.
  local head="${LEAK_GATE_HEAD_SHA:-HEAD}"
  git -C "$SCAN_ROOT" rev-parse --verify -q "${head}^{commit}" >/dev/null 2>&1 || head=HEAD
  git -C "$SCAN_ROOT" log --no-merges --format='%s%n%b' "${base}..${head}" 2>/dev/null \
    | awk '{ printf "COMMIT-MESSAGE:%d:%s\n", NR, $0 }' >> "$MSG_VIEW"
  # PR title/body arrive via env and are NEVER interpolated into a shell command
  # (a PR body is attacker-controlled text; `${{ github.event… }}` inside `run:`
  # is a script-injection sink, inside `env:` it is not).
  { [ -n "${LEAK_GATE_PR_TITLE:-}" ] && printf '%s\n' "$LEAK_GATE_PR_TITLE"
    [ -n "${LEAK_GATE_PR_BODY:-}"  ] && printf '%s\n' "$LEAK_GATE_PR_BODY"
    true
  } | awk '{ printf "PR-TITLE-BODY:%d:%s\n", NR, $0 }' >> "$MSG_VIEW"
  return 0
}
run_grep_messages() {
  local mode="$1" pattern="$2"
  [ "$mode" = "ci" ] && pattern="$(printf '%s' "$pattern" | tr 'A-Z' 'a-z')"
  awk -v pat="$pattern" -v ci="$([ "$mode" = "ci" ] && echo 1 || echo 0)" '
    { text=$0; sub(/^[^:]*:[0-9]+:/,"",text)
      probe = text
      if (ci) probe = tolower(text)
      if (probe ~ pat) print $0 }' "$MSG_VIEW" 2>/dev/null || true
}
grep_rule_messages() { local rule="$1"; shift; report_hits "$rule" < <(run_grep_messages "$@"); }

if build_message_view; then
  echo "  message lines in scan window: $(wc -l < "$MSG_VIEW" | tr -d ' ')"
  grep_rule_messages private-path-msg ci "$PRIVATE_PATH_RE"
  grep_rule_messages neutron-computer-msg ci 'neutron\.computer'
  [ -n "$PII_SUB_ALT" ]  && grep_rule_messages pii-denylist-msg      ci "(${PII_SUB_ALT})"
  [ -n "$PII_WORD_ALT" ] && grep_rule_messages pii-denylist-word-msg cs "(^|[^A-Za-z0-9_])(${PII_WORD_ALT})([^A-Za-z0-9_]|\$)"
elif [ "$IN_CI" = "1" ]; then
  cat >&2 <<'EOF'
leak-gate: FATAL — could not determine a commit range to scan. Commit messages and
PR bodies are mirrored to GHArchive permanently and cannot be redacted after the
fact, so skipping them in CI is not an option.

Fix: the purity job needs `fetch-depth: 0` and `LEAK_GATE_BASE_SHA`
(github.event.pull_request.base.sha || github.event.before). See ci.yml.
EOF
  exit 2
elif [ "$MESSAGES_ONLY" = "1" ]; then
  # In this mode the message scan is the ENTIRE job. Not resolving a range means
  # the gate checked nothing whatsoever, so it must never look like a pass.
  echo "leak-gate: FATAL — --messages-only, but no commit range could be resolved." >&2
  echo "           Nothing was scanned. Is this a git work tree with an 'origin/main'?" >&2
  exit 2
elif git -C "$SCAN_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # A git repo whose scan window could not be resolved (no LEAK_GATE_BASE_SHA and
  # no origin/main). There ARE messages here and they were NOT examined, which is
  # materially different from the case below.
  echo "  could not resolve a commit range — messages NOT scanned" >&2
  note_unrun "private-path-msg, neutron-computer-msg, pii-denylist-msg"
else
  # Not a git work tree at all: there are no commit messages in scope, so nothing
  # went unchecked. An empty surface is not an unexamined one, and conflating the
  # two would make every non-repo scan permanently INCOMPLETE — noise that trains
  # people to ignore the verdict that matters.
  echo "  (not a git work tree and not in CI — message scan not applicable)"
fi

if [ "$MESSAGES_ONLY" = "0" ]; then
echo
# ── Tier 3: structural ────────────────────────────────────────────────────────
echo "── Tier 3: structural ─────────────────────────────────────────────────"
FORBIDDEN_PREFIXES='tenancy/ tenant-provisioning/ signup/ identity/ proxy/'
# RT1 tripwire — root `SPEC.md` is DELIBERATELY absent from this list as of K10.
# K10 intentionally introduces a root SPEC.md (the public master spec), which
# flips the repo into Ralph-governed mode (`detectRalphMode` in
# trident/git-mode.ts keys off a root SPEC.md). That flip is now INTENDED, so a
# root SPEC.md must NOT trip forbidden-path. The remaining root files stay
# banned as carve tripwires against Managed's private root docs re-entering the
# public tree (STATUS.md/ISSUES.md/CLAUDE.md/AGENTS.md).
FORBIDDEN_EXACT='STATUS.md ISSUES.md CLAUDE.md AGENTS.md'
forbidden_path_hits() {
  local f p
  while IFS= read -r f; do
    for p in $FORBIDDEN_PREFIXES; do
      case "$f" in "$p"*) printf '%s:1:forbidden Managed path (matches "%s")\n' "$f" "$p" ;; esac
    done
    for p in $FORBIDDEN_EXACT; do
      [ "$f" = "$p" ] && printf '%s:1:forbidden root file\n' "$f"
    done
  done < "$FILELIST"
}
report_hits forbidden-path < <(forbidden_path_hits)

report_hits secret-file < <(
  grep -E '(^|/)\.env([^/]*)?$|\.pem$|\.key$|\.p12$|\.pfx$' "$FILELIST" \
    | sed 's/$/:1:secret-material file extension/'
)

# Managed workspace names must never survive in the lockfile/manifests.
for cfg in bun.lock tsconfig.json package.json; do
  [ -f "$SCAN_ROOT/$cfg" ] || continue
  report_hits config-purity < <(
    cd "$SCAN_ROOT" && grep -EnH '"(tenant-provisioning|identity|signup|tenancy|proxy)"|tenant-provisioning/|paid-staging|dtc-analytics|@neutron-paid|@neutronai/(tenant-provisioning|identity|signup|tenancy|proxy)' "$cfg" 2>/dev/null || true
  )
done

# LICENSE must be the real Apache-2.0 text.
if [ ! -f "$SCAN_ROOT/LICENSE" ] \
   || ! grep -q 'Apache License' "$SCAN_ROOT/LICENSE" \
   || ! grep -q 'Version 2.0, January 2004' "$SCAN_ROOT/LICENSE"; then
  report_hits license-stub < <(printf 'LICENSE:1:missing or not the full Apache-2.0 text\n')
fi

# ── Tier 3b: binary-hiding tripwire (unit G7) ──────────────────────────────────
# EVERY vocab/PII/structural rule above runs through `grep -I`, which SILENTLY
# skips any file it classifies as binary — i.e. any file that contains a raw NUL
# (0x00) byte. So a banned token embedded next to a NUL is INVISIBLE to the whole
# gate, forever. That is not hypothetical: the history-import hash-seed `tenant:`
# token (tasks/history-import-seeder.ts) and a retired multi-tenant fixture path
# (…/dead-repl-detector.test.ts) both evaded a "zero-tolerance" gate this exact way
# until 2026-07-03. This tripwire closes the whole class: any tracked file that
# contains a NUL byte is a hard finding UNLESS it is a known binary-asset class
# (images/fonts/archives/compiled — exempt by extension) or is exempted by exact
# path in the committed allowlist (rule id: binary-hidden). It is FAIL-CLOSED —
# an UNKNOWN extension carrying a NUL trips — so a new binary asset type must be
# added to the extension list (or allowlisted) deliberately, and a source file
# can never re-acquire a hidden NUL. NUL detection is byte-exact and locale-safe
# (LC_ALL=C tr | cmp), so it never itself trips grep's binary heuristic.
KNOWN_BINARY_EXT_RE='\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|svgz|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|bz2|xz|zst|7z|rar|tar|mp3|mp4|m4a|mov|avi|webm|wav|ogg|oga|flac|aac|wasm|so|dylib|dll|node|jar|class|pyc|pyo|bin|dat|db|sqlite3?|wal|p12|pfx|jks|keystore)$'
binary_hidden_hits() {
  local f
  while IFS= read -r f; do
    # Known binary-asset extensions legitimately carry NULs — skip them.
    printf '%s' "$f" | grep -qiE "$KNOWN_BINARY_EXT_RE" && continue
    # A file is "binary to grep" iff it contains a NUL byte. Strip NULs and
    # compare to the original: identical ⇒ no NUL ⇒ visible to the gate.
    if ! LC_ALL=C tr -d '\000' < "$SCAN_ROOT/$f" 2>/dev/null | cmp -s - "$SCAN_ROOT/$f"; then
      printf '%s:1:tracked file is binary to grep (contains a NUL byte) — hides tokens from every rule above\n' "$f"
    fi
  done < "$FILELIST"
}
report_hits binary-hidden < <(binary_hidden_hits)
fi  # ── end tree-only rules (Tier 1 PATH / hosted-domain / Tier 3) ─────────────

# ── Verdict ───────────────────────────────────────────────────────────────────
echo
echo "── Summary ────────────────────────────────────────────────────────────"
[ -n "$SUMMARY" ] && printf '%b' "$SUMMARY"
echo "    allowlisted (suppressed): $ALLOWLISTED_COUNT"
echo "    TOTAL FINDINGS: $TOTAL_FINDINGS"
[ -n "$UNRUN_RULES" ] && echo "    RULES THAT COULD NOT RUN: $UNRUN_RULES"
if [ "$TOTAL_FINDINGS" -gt 0 ]; then
  echo "LEAK GATE: FAIL — the public tree must be fully silent."
  exit 1
fi
# "Found nothing" and "looked at nothing" are different results and must not
# share a verdict or an exit code. Canonical CI can never reach here with an
# unrun rule (that path exits 2 above); a fork PR is exempted by design and keeps
# its exit 0, covered by the nightly full scan. What is left is a local run,
# which now says so and exits 3.
if [ -n "$UNRUN_RULES" ]; then
  echo "LEAK GATE: INCOMPLETE — 0 findings from the rules that RAN, but the rules"
  echo "                        above did NOT run. This is not a clean result."
  exit 3
fi
echo "LEAK GATE: SILENT ✅"
exit 0
