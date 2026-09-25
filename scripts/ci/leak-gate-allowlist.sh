#!/usr/bin/env bash
# Shared preparation for the purity gate and its focused allowlist self-test.
# Source this library; it is not a gate entry point and produces no clean verdict.
# The caller supplies HERE, SCAN_ROOT, ALLOWLIST_FILE and a temporary FILELIST.
prepare_leak_gate_allowlist() {
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
}
