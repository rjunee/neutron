#!/usr/bin/env bash
#
# scripts/ci/leak-gate.sh — the PUBLIC Neutron Open purity gate.
#
# This is the self-contained Tier-2/Tier-3 SUBSET of the private carve-time gate
# (scripts/sprint-c/leak-gate.sh, which is Managed-only and never ships). It runs
# in the public Open repo's CI on every PR + push so the public tree can never
# regress to multi-tenant vocabulary or accidentally re-absorb a Managed module.
#
# WHY A SUBSET (not the full gate): the private gate's Tier-1 owner/PII/infra
# token list NAMES the very strings it bans — publishing it would itself leak
# those tokens. So this public copy carries ONLY:
#   * Tier-2 PROSE   — no "tenant"/"multi-tenant" notion in comments/docs.
#   * Tier-2 CODE    — zero-tolerance over the live multi-tenant surface
#                      (tenant_slug / tenant_home / TenantDb / NEUTRON_TENANT_* /
#                      tenant_provisioned, cross-tenant, tenant-scoped provisioning).
#   * neutron.computer — zero-tolerance hosted-domain rule (self-host-only Open).
#   * Tier-3 STRUCTURAL — no Managed module dir, no tracked secret files, no
#                      Managed workspace name in the lockfile/manifests, real
#                      Apache-2.0 LICENSE.
# It carries NO Tier-1 PII token list. The full private gate still runs at carve
# time + on the Managed nightly.
#
# USAGE
#   scripts/ci/leak-gate.sh [dir]          # scan dir (default: .)
#   scripts/ci/leak-gate.sh --tree <dir>   # same; --tree accepted for parity
#                                          # with the private gate's invocation
#
# EXIT: 0 = silent (clean), 1 = findings, 2 = usage/internal error. There is no
# skip flag and no env bypass; the only exception mechanism is the committed,
# reviewable allowlist (scripts/ci/leak-gate-allowlist.txt, `<glob>:<rule-id>`).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ALLOWLIST_FILE="$HERE/leak-gate-allowlist.txt"
PROSE_AWK="$HERE/extract-comment-prose.awk"

SCAN_ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --tree)
      [ $# -ge 2 ] || { echo "leak-gate: --tree requires a directory argument" >&2; exit 2; }
      SCAN_ROOT="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "leak-gate: unknown argument '$1' (the gate is non-skippable)" >&2; exit 2 ;;
    *) SCAN_ROOT="$1"; shift ;;
  esac
done
SCAN_ROOT="$(cd "$SCAN_ROOT" && pwd)" || { echo "leak-gate: cannot cd to scan root" >&2; exit 2; }
[ -f "$PROSE_AWK" ] || { echo "leak-gate: missing $PROSE_AWK (prose extractor)" >&2; exit 2; }

FILELIST="$(mktemp)"; PROSE_VIEW="$(mktemp)"
trap 'rm -f "$FILELIST" "$PROSE_VIEW"' EXIT

# Every file in the tree is in scope (mirror the private gate's --tree mode).
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
(cd "$SCAN_ROOT" && tr '\n' '\0' < "$FILELIST" | xargs -0 awk -f "$PROSE_AWK" 2>/dev/null) > "$PROSE_VIEW" || true
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

echo "leak-gate (public subset) — scan root: $SCAN_ROOT"
echo "candidate files: $TOTAL_FILES"
echo

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

echo
# ── Tier 1: owner PII denylist (supplied out-of-band — NEVER committed) ───────
# The public repo carries NO owner PII whatsoever — not in plaintext and not
# encoded (base64 is trivially reversible, so an embedded blob would itself be
# the leak). Instead the denylist is injected at CI time via the
# `LEAK_GATE_PII_DENYLIST_B64` environment variable: a private CI runner sets it
# (newline-separated proper nouns, base64-encoded) so the gate still trips if any
# of them regress into the tree, while the public checkout ships an empty default
# and simply SKIPS Tier-1 (see the WARNING branch below). Matching is
# case-SENSITIVE + word-bounded so ordinary words do not false-positive against
# capitalised proper-noun forms. A legitimate future capitalised collision is
# handled via the reviewable allowlist (rule id: pii-denylist), same as every
# other rule.
echo "── Tier 1: owner PII denylist (env-supplied) ──────────────────────────"
PII_DENYLIST_B64="${LEAK_GATE_PII_DENYLIST_B64:-}"
PII_DENYLIST_ALT="$(printf '%s' "$PII_DENYLIST_B64" | base64 -d 2>/dev/null | grep -v '^$' | paste -sd'|' -)"
if [ -n "$PII_DENYLIST_ALT" ]; then
  grep_rule pii-denylist cs "\\b(${PII_DENYLIST_ALT})\\b"
else
  echo "leak-gate: WARNING — LEAK_GATE_PII_DENYLIST_B64 is unset (or undecodable); Tier-1 PII rule SKIPPED" >&2
fi

echo
# ── Tier 1 (shape-only, zero PII): hosted-domain rule ─────────────────────────
echo "── hosted-domain (self-host-only Open) ────────────────────────────────"
grep_rule neutron-computer ci 'neutron\.computer'

echo
# ── Tier 3: structural ────────────────────────────────────────────────────────
echo "── Tier 3: structural ─────────────────────────────────────────────────"
FORBIDDEN_PREFIXES='tenancy/ tenant-provisioning/ signup/ identity/ proxy/'
# RT1 tripwire — K10 removes SPEC.md from this list when it intentionally
# introduces a root SPEC.md (`detectRalphMode` in trident/git-mode.ts flips a
# repo into Ralph-governed mode the instant a root SPEC.md exists, so an
# ACCIDENTAL one mid-window would silently change `/code` behavior).
FORBIDDEN_EXACT='STATUS.md ISSUES.md CLAUDE.md AGENTS.md SPEC.md'
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
# (…/wedge-detector.test.ts) both evaded a "zero-tolerance" gate this exact way
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

# ── Verdict ───────────────────────────────────────────────────────────────────
echo
echo "── Summary ────────────────────────────────────────────────────────────"
[ -n "$SUMMARY" ] && printf '%b' "$SUMMARY"
echo "    allowlisted (suppressed): $ALLOWLISTED_COUNT"
echo "    TOTAL FINDINGS: $TOTAL_FINDINGS"
if [ "$TOTAL_FINDINGS" -gt 0 ]; then
  echo "LEAK GATE: FAIL — the public tree must be fully silent."
  exit 1
fi
echo "LEAK GATE: SILENT ✅"
exit 0
