#!/usr/bin/env bash
# =============================================================================
# trident/checkpoint.sh — hardened idempotent checkpoint writes (refactor P10)
# =============================================================================
#
# The inner workflow's Bash checkpoint steps used to embed raw sqlite UPDATE
# statements in the agent prompt (LLM-transcribed) and ran `sqlite3` with the
# default busy_timeout=0 — a write that landed while another process held the
# db lock FAILED INSTANTLY, and a lost terminal write meant no harvest until
# the 25m reaper. This checked-in script replaces that inline SQL:
#
#   * `PRAGMA busy_timeout=5000;` is prepended IN THE SAME sqlite3 invocation
#     (busy_timeout is per-connection), so writes retry for up to 5s under
#     lock instead of failing instantly.
#   * The agent now invokes ONE fixed command with field/value args — no SQL
#     for the LLM to transcribe (and mistranscribe).
#
# Usage:
#   checkpoint.sh <db> <run-id> <field> <value> [<field> <value> ...]
#
# Fields (whitelisted; anything else is an error):
#   pr <int>                 → pr=<int>                          (numeric)
#   branch <str>             → branch='<str>'
#   brief_alert <str>        → brief_alert='<str>'
#   inner_checkpoint <str>   → inner_checkpoint='<str>', and DERIVES two more
#                              columns from that NAME: `phase`
#                              (phase_for_checkpoint, frozen on a terminal row)
#                              and `round` (round_for_checkpoint, monotonic MAX,
#                              deliberately NOT frozen)
#   inner_checkpoint_head <str>
#                            → inner_checkpoint_head='<str>'
#   inner_findings_file <path>
#                            → inner_checkpoint_findings=<the file's bytes as a
#                              SQL literal, or NULL when it is missing>, and
#                              DEMOTES a stored `REQUEST_CHANGES` to
#                              `REVIEW_NOT_RUN` when it empties the findings
#   subagent_status <str>    → subagent_status='<str>'          (LIVENESS: frozen)
#   inner_verdict <str>      → inner_verdict='<str>', EXCEPT `REQUEST_CHANGES`,
#                              which is written only when the row is left carrying
#                              a non-empty JSON array of findings and is otherwise
#                              REFUSED and recorded as `REVIEW_NOT_RUN` (see "THE
#                              VERDICT WRITE"). AN EMPTY `<str>` CLEARS the column
#                              to NULL — except on a settled terminal row, where a
#                              write bringing no findings may not erase the review
#                              it cannot justify, and the recorded verdict stands.
#   inner_result_file <path> → inner_result=<the file's bytes as a SQL literal, or
#                              NULL when it is missing>,
#                              subagent_status=CASE WHEN length(<those same bytes>)
#                                > 0 THEN 'completed' ELSE subagent_status END
#                                                               (LIVENESS: frozen)
#
# BOTH `*_file` FIELDS ARE READ ONCE, in bash (`read_file_literal`), rather than
# through `readfile()` in the SQL: `readfile()` is re-evaluated at every mention,
# and the verdict CASE mentions the findings nine times.
#
# Every value above is wrapped in `frozen()` when it targets one of the two
# LIVENESS columns — see the block above the field loop for what that means.
#
# `last_advanced_at='<now UTC, %FT%T.%3NZ>'` is appended for workflow progress
# checkpoints. A standalone `brief_alert` is observability, not progress, so it
# deliberately leaves the hang-watchdog heartbeat untouched. The script computes
# stamps so the prompt carries no command substitution and uses MILLISECONDS (see
# the stamp block below, including the whole-second fallback). It and
# `subagent_status` are the LIVENESS pair, frozen on a terminal row.
#
# SEMANTICS ARE UNCHANGED from the inline SQL this replaces
# (trident/inner-workflow.mjs checkpoint()/writeTerminalResult()), EXCEPT that
# the two LIVENESS columns are frozen once the row reaches a terminal phase
# (see `frozen()` below):
#   * same table (code_trident_runs), same WHERE id='<run-id>' row selection;
#   * same column/value SET pairs (SET order is irrelevant in SQLite — every
#     RHS sees the OLD row, incl. the `ELSE subagent_status` in the CASE);
#   * idempotent: re-running the same checkpoint yields the same row state.
#   * `inner_result_file` keeps the file indirection so the JSON's own quotes can
#     never break the sqlite argument, and keeps the COLUMN-CONSISTENCY guard:
#     subagent_status flips to 'completed' ONLY when the SAME bytes just stored
#     are non-empty text (a missing/empty temp file leaves inner_result NULL and
#     subagent_status untouched).
#
# Values are SQL-escaped (' → '') — strictly safer than the raw interpolation
# it replaces; the values that actually occur (uuids, slugs, enum names,
# /tmp paths) contain no quotes, so emitted SQL is unchanged for them.
set -euo pipefail

usage="usage: checkpoint.sh <db> <run-id> <field> <value> [<field> <value> ...]"
db="${1:?$usage}"
run="${2:?$usage}"
shift 2

if [ "$#" -eq 0 ]; then
  echo "checkpoint.sh: no fields given — $usage" >&2
  exit 2
fi

# Escape a value for inclusion inside a single-quoted SQL string literal (' → '').
#
# LINEAR, NOT QUADRATIC (Argus r24, minor). This was `${s//$q/$q$q}`, and bash's
# pattern substitution rebuilds the result buffer per match: measured on the build
# box at 1.12 s for a 50 KB dense-apostrophe payload, 18.5 s at 200 KB and 62.7 s
# at 400 KB (0.08 s when quote-free). That is on the write that RECORDS THE VERDICT
# — the findings literal comes through here via `read_file_literal` — and nothing
# upstream bounds the size of a findings array. The live corpus tops out around
# 14 KB, so this was never a live stall; it was one bad review away from being one.
#
# THE SENTINEL IS WHAT MAKES A SUBPROCESS SAFE HERE. `sed` is a LINE tool: a BSD
# sed appends a trailing newline to input that lacks one, which would corrupt the
# byte-verbatim round trip `read_file_literal` is pinned on. Appending `X` inside
# the pipeline puts any such newline AFTER the sentinel, where `$( … )`'s own
# trailing-newline stripping removes it, and `${out%X}` then removes the sentinel —
# so the output is the input's bytes plus the doubled quotes, on any sed.
#
# AND A SUBPROCESS THAT FAILS MUST NOT TAKE THE WRITE WITH IT (Argus r4, minor).
# `set -euo pipefail` is on, so an unavailable/killed `sed` would abort the script
# BEFORE the UPDATE — the run's row keeps its stale phase and verdict, which is the
# blind row this file's docblock forbids, arrived at from the other side. The pure
# bash substitution is kept as the fallback: quadratic, which is why it is not the
# primary, but a slow correct write beats no write at all.
sql_quote() {
  local out
  if out="$( { printf '%s' "$1"; printf 'X'; } | sed "s/'/''/g" )"; then
    printf '%s' "${out%X}"
    return 0
  fi
  local q="'"
  printf '%s' "${1//$q/$q$q}"
}

# READ A FILE ONCE, AS A SQL LITERAL — the replacement for `CAST(readfile(<path>)
# AS TEXT)` appearing more than once in a single statement (Argus r8 blocker).
#
# `readfile()` is a FUNCTION, not a value: SQLite re-evaluates it at every
# occurrence, and the verdict CASE below mentions the findings expression nine
# times (once for the column, eight more inside `json_valid`/the BOM `SUBSTR`/the NUL
# `INSTR`/the three the UTF-8 gate and scan need/`json_type`/`json_array_length`). A writer that
# replaced the file between two of those
# evaluations therefore got a row whose `inner_verdict` was decided from DIFFERENT
# bytes than the ones stored in `inner_checkpoint_findings` — reproduced by Argus
# at iteration 132 of a 300-write alternating-file run, which persisted exactly the
# `REQUEST_CHANGES` + `[]` row this script exists to make unwritable. Materialising
# the contents HERE makes every mention of the expression the SAME constant, so the
# check and the write can no longer see different bytes however the file moves.
#
# THE readfile() SEMANTICS ARE PRESERVED EXACTLY, because two tests pin them:
#   * a missing (or unreadable, or non-regular) path yields SQL NULL, not '' —
#     "a MISSING findings file leaves the column NULL and never fails the build";
#   * the bytes round-trip verbatim, INCLUDING a trailing newline, which plain
#     `$(cat)` would strip — hence the `printf X` sentinel.
# Embedded NUL bytes are the one difference, and they cannot occur: both files
# hold `JSON.stringify` output, which escapes every control character.
read_file_literal() {
  local path="$1" content
  if [ ! -f "$path" ] || [ ! -r "$path" ]; then
    printf 'NULL'
    return 0
  fi
  content="$(cat -- "$path" 2>/dev/null; printf X)"
  literal_of "${content%X}"
}

# The literal half of the above, split out so the findings path can hold the BYTES
# as well as the literal. `read_file_literal` runs inside a `$( … )`, i.e. a
# SUBSHELL, so nothing it learns about the content survives the call — and reading
# the file a second time to learn it is the very TOCTOU that function exists to
# close. The findings branch therefore does the read itself and quotes through here.
#
# THE SENTINEL IS NEEDED TWICE, not once (Argus r1). `$(...)` strips trailing
# newlines from its OUTPUT as well as from what it captures, so quoting through a
# bare `$(sql_quote "$content")` re-stripped exactly the bytes the `printf X` in the
# reader had just preserved: a file holding `abc\n` emitted `'abc'`. Escaping stays
# in `sql_quote` — one copy of the ' → '' rule — and the sentinel is re-applied
# around it. The literal itself ends in `'`, so the caller's own `$( … )` capture
# has no trailing newline left to strip.
literal_of() {
  local quoted
  quoted="$(sql_quote "$1"; printf X)"
  quoted="${quoted%X}"
  printf "'%s'" "$quoted"
}

# The findings test — `parseCheckpointFindings` (trident/checkpoint-findings.ts)
# expressed in SQL: well-formed JSON, an ARRAY, at least one element. Emitted as a
# CASE so this script has ONE copy of the predicate rather than one per write site.
#
# THE NESTING IS DELIBERATE, not style: `json_type`/`json_array_length` RAISE on
# malformed text, so they are reached only under `json_valid`. `json_valid(NULL)`
# is NULL, which falls to the ELSE. `json_array_length` answers 0 for a non-array,
# so the inner AND is safe whatever order SQLite evaluates it in.
#
# THE BOM CLAUSE MIRRORS THE PARSER'S (Argus r15). `parseCheckpointFindings` pins a
# leading U+FEFF as "not findings" explicitly rather than leaning on `JSON.parse`
# throwing; this is the same pin in SQL, so the two dialects answer alike BY
# CONSTRUCTION. Measured over a value whose stored bytes really do begin EF BB BF,
# `json_valid` already answers 0 on BOTH engines this project runs (sqlite3 CLI
# 3.45.1 and bun:sqlite 3.51.2) — so the clause changes no answer today and exists
# so an engine that started tolerating the mark could not quietly promote it to a
# rejection here while the parser still read it as empty. The expression is a
# materialised literal, so mentioning it once more costs nothing and re-evaluates
# nothing.
# AND THE NUL CLAUSE MIRRORS THE COUNTING SQL'S (Argus r22, nit). The canonical
# statements in `docs/AS_BUILT.md` also carry `INSTR(…, CHAR(0)) = 0`, because
# SQLite's JSON functions stop at an embedded NUL while `JSON.parse` sees the whole
# value and throws on the trailing bytes. Without it here, a historical row holding
# such a value is "a settled rejection" to `settled_rejection` below — which applies
# the clause to the STORED column — and "legacy" to the counting SQL, i.e. the three
# copies of one predicate stop being one predicate. Bash cannot even carry a NUL
# through an argument, so no write from THIS script can produce the shape; the clause
# is parity for the rows that already exist, and it costs one more mention of a
# materialised literal.
# AND MALFORMED UTF-8 IS THE SHAPE THIS SCRIPT CAN ACTUALLY WRITE (Argus r3, blocker,
# reproduced). Unlike a NUL, invalid UTF-8 travels through argv and through a findings
# FILE perfectly well, and SQLite's JSON parser accepts any byte >= 0x20 inside a
# string literal — so `[{"t":"<0x80>"}]` in the findings file was `json_valid` = 1, an
# array, non-empty, and this CASE recorded `REQUEST_CHANGES` with it. Every reader of
# that column then goes through bun:sqlite, whose driver returns the EMPTY STRING for a
# value that is not well-formed UTF-8: `parseCheckpointFindings` is handed "" and
# answers [], so the row reads back as precisely the REQUEST_CHANGES-with-no-findings
# shape this script exists to make unwritable. The `NOT EXISTS` scan closes it by
# asking the only question SQLite can answer about bytes — it splits text into
# characters with its own UTF-8 reader, and re-encoding each character
# (`CHAR(UNICODE(ch))`) reproduces the original bytes IF AND ONLY IF they were well
# formed: an orphan continuation byte re-encodes to two bytes, and an overlong, a
# surrogate, a truncated or an out-of-range sequence reads back as U+FFFD and
# re-encodes to EF BF BD. U+FFFE and U+FFFF are the two false positives — well-formed
# UTF-8 that SQLite's reader also folds to U+FFFD — so they are excluded by hand
# rather than left to demote findings the parser reads perfectly well. Measured over
# 32 byte shapes on BOTH engines this project runs (sqlite3 CLI 3.45.1 and bun:sqlite
# 3.51.2) the clause agrees row for row with `new TextDecoder('utf-8', {fatal: true})`,
# which is exactly the boundary bun's driver enforces; the same clause is in the
# canonical counting SQL in `docs/AS_BUILT.md`, so the three copies answer alike ON
# THE VALUES THEY ALL WALK. That parity is SCOPED, and the scope is this script's
# alone (Argus r5): the other two copies — the documented counting statements and
# `parseCheckpointFindings` — are unbounded readers of rows that already exist,
# while THIS copy is the write path and carries a cost ceiling (`utf8_scan_max`
# below) over the one operand it cannot decide in bash. Above that ceiling this copy
# stops walking and answers fail-closed per question, so it can answer "not
# well-formed" where the other two, given the time, would answer "well-formed". The
# divergence is stated where the ceiling is set, and its live residue is the
# named follow-up recorded in `docs/AS_BUILT.md`.
# THE GLOB IN FRONT OF THE SCAN IS A COST GATE, NOT A SECOND OPINION, and this is the
# write site where the cost lands. "Every character is TAB, LF, CR or printable ASCII"
# is sufficient for well-formed UTF-8 on its own, so an all-ASCII findings payload skips
# the walk entirely — which is FEWER payloads than this comment once claimed ("every one
# this system has written, `JSON.stringify` escaping the rest"): `JSON.stringify` emits
# raw non-ASCII bytes and LLM findings carry em dashes, so real rejections miss the gate
# routinely, which is why the sizes below matter and why the ceiling under them exists.
# It matters because SQLite's SUBSTR on TEXT is O(offset), making the
# walk quadratic: measured here, a 200 KB payload costs 30 s ungated and 3 ms gated, and
# this script is handed findings files deliberately larger than one argv element. A
# payload that really does carry non-ASCII still pays, bounded by its size (14 KB, the
# live maximum, measures 123 ms). The gate can only skip a scan that had nothing to
# find, so it changes no answer — `as-built-disposition-sql.test.ts` runs corpus rows on
# both sides of it.
# WHAT THIS PREDICATE DOES **NOT** ASK, stated so a future writer cannot open the
# gap by accident (Argus r24, latent). `recordedTerminalVerdict`
# (trident/orchestrator.ts) admits a REQUEST_CHANGES only when the checkpoint ALSO
# carries Argus provenance (`hasArgusProvenance`); this script asks only whether the
# findings are a real, non-empty array. So a `REQUEST_CHANGES` written HERE at, say,
# `forge-done` with findings attached lands, and reads back as `reviewed-rejected` to
# the classifier, while the TS write site would have refused it. It is unreachable
# today — every writer of a terminal verdict goes through `writeTerminalResult`
# (inner-workflow.mjs), which requires a code-level block WITH findings, and the
# suite gate rides a panel that always stamps an `argus-*` checkpoint first. The
# provenance test is deliberately NOT copied down here: it belongs to the merge
# decision, which this script does not make, and a fourth copy of it in bash is a
# fourth thing to drift. What must not happen is a NEW non-panel writer calling this
# script with a verdict; if one is ever added, the provenance check comes with it.
#   $1 — the findings SQL expression (a literal, per read_file_literal above)
#   $2 — SQL value when the findings are a real, non-empty rejection
#   $3 — SQL value otherwise
#   $4 — the UTF-8 well-formedness test for $1, as SQL (see utf8_wellformed below);
#        callers pass it explicitly because the two kinds of operand this predicate
#        runs over — a literal bash HAS, and the old row's stored column — are
#        decided by different machinery and fail in opposite directions.
findings_case() {
  printf "CASE WHEN json_valid(%s) AND SUBSTR(%s, 1, 1) <> CHAR(65279) AND INSTR(%s, CHAR(0)) = 0 AND (%s) THEN CASE WHEN json_type(%s) = 'array' AND json_array_length(%s) > 0 THEN %s ELSE %s END ELSE %s END" \
    "$1" "$1" "$1" "$4" "$1" "$1" "$2" "$3" "$3"
}

# THE UTF-8 SCAN, AND ITS COST CEILING (Argus r4 blocker, reproduced).
#
# The GLOB in front of the scan was written as a cost gate whose stated premise —
# "an all-ASCII findings payload … is every one this system has written,
# `JSON.stringify` escaping the rest" — is simply FALSE: `JSON.stringify` emits
# raw non-ASCII bytes, and LLM-authored findings carry em dashes and curly quotes
# as a matter of course. So the gate misses, and what it lets through is quadratic:
# SQLite's SUBSTR on TEXT is O(offset), measured on this box at 0.18 s for 8 K
# characters, 0.73 s at 16 K, 3.0 s at 32 K and 12.4 s at 64 K, on the write that
# RECORDS THE VERDICT, with nothing upstream bounding the size of a findings array.
#
# Two operands reach this predicate and neither is fixed by tightening the GLOB:
#
#   * THE LITERAL this invocation brings. bash already holds those bytes, so the
#     answer is decided HERE, in one linear pass (`utf8_verdict`), and what reaches
#     SQL is the constant 1 or 0 — no walk at any size. That is the fix; the SQL
#     below is only its fallback for a host with no `iconv`.
#   * THE OLD ROW'S STORED COLUMN, read by `settled_rejection` inside the same
#     atomic UPDATE. bash does not have those bytes and cannot read them without
#     re-opening the TOCTOU `read_file_literal` exists to close, so the scan stays —
#     under a ceiling, above which it is not run at all.
#
# $2 IS THE ANSWER ABOVE THE CEILING, and it is per-caller because "I could not
# check" fails in opposite directions for the two uses. For the stored column the
# only question asked is "is this row a settled rejection whose findings must not be
# erased", so an unverifiable value answers 1 — refuse the erasure. For the literal
# it answers 0 — a rejection this script cannot justify is recorded REVIEW_NOT_RUN,
# which is this whole script's fail-closed direction. Neither answer can merge
# anything, and no live payload is near the ceiling (the corpus tops out ~14 KB).
utf8_scan_max=16384
utf8_wellformed() {
  printf "%s NOT GLOB ('*[^' || CHAR(9) || CHAR(10) || CHAR(13) || ' -~]*') OR CASE WHEN LENGTH(%s) > %s THEN %s ELSE NOT EXISTS (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < LENGTH(%s)) SELECT 1 FROM (SELECT CAST(SUBSTR(%s, i, 1) AS BLOB) AS b FROM c) WHERE b <> CAST(CHAR(UNICODE(CAST(b AS TEXT))) AS BLOB) AND b NOT IN (x'EFBFBE', x'EFBFBF')) END" \
    "$1" "$1" "$utf8_scan_max" "$2" "$1" "$1"
}

# The same question about bytes bash HAS, answered linearly: '1' well-formed, '0'
# not, '' when this host cannot tell and the SQL scan must decide instead.
#
# `iconv -f UTF-8 -t UTF-32LE` is the exact boundary the scan draws, verified byte
# shape by byte shape: it rejects an orphan continuation, an overlong, a surrogate,
# a truncated and an out-of-range sequence, and ACCEPTS U+FFFE/U+FFFF — the two
# noncharacters SQLite's own reader folds to U+FFFD and the scan therefore excludes
# by hand. (`-t UTF-8` alone is NOT that boundary: glibc passes U+110000 through.)
# It reads the bytes bash already captured, on stdin, so it cannot see a different
# file than the one being stored, and it never appears in argv.
#
# AND `iconv` IS NOT A PRECONDITION FOR RECORDING A REAL REJECTION (Argus r5). A
# host without it fell back to the ceilinged SQL scan, so on that host a genuine
# review whose findings ran past 16,384 characters — one long non-ASCII payload —
# was recorded `REVIEW_NOT_RUN`: fail-closed, but it discards a real rejection and
# leaves the row salvage-seed eligible, which is the waste this card is about. The
# fallback below asks the SAME question over the SAME bytes in the same single
# linear pass, using only `od` and `awk` (both POSIX), so the answer no longer
# depends on which converters the host ships. The state machine IS RFC 3629, which
# is what `-t UTF-32LE` enforces: C2..DF/E0..EF/F0..F4 lead bytes with the
# overlong (E0 A0, F0 90), surrogate (ED 80..9F) and out-of-range (F4 80..8F)
# bounds written out, every continuation 80..BF, and no exclusion for
# U+FFFE/U+FFFF. Decimal literals, because hex constants are not portable awk.
utf8_verdict() {
  if command -v iconv >/dev/null 2>&1; then
    if printf '%s' "$1" | iconv -f UTF-8 -t UTF-32LE >/dev/null 2>&1; then
      printf '1'
    else
      printf '0'
    fi
    return 0
  fi
  command -v od >/dev/null 2>&1 || return 0
  command -v awk >/dev/null 2>&1 || return 0
  if printf '%s' "$1" | od -An -v -tu1 | awk '
    {
      for (i = 1; i <= NF; i++) {
        b = $i + 0
        if (n == 0) {
          if (b < 128) continue
          else if (b >= 194 && b <= 223) { n = 1; lo = 128; hi = 191 }
          else if (b == 224) { n = 2; lo = 160; hi = 191 }
          else if (b >= 225 && b <= 236) { n = 2; lo = 128; hi = 191 }
          else if (b == 237) { n = 2; lo = 128; hi = 159 }
          else if (b >= 238 && b <= 239) { n = 2; lo = 128; hi = 191 }
          else if (b == 240) { n = 3; lo = 144; hi = 191 }
          else if (b >= 241 && b <= 243) { n = 3; lo = 128; hi = 191 }
          else if (b == 244) { n = 3; lo = 128; hi = 143 }
          else { bad = 1; exit }
        } else {
          if (b < lo || b > hi) { bad = 1; exit }
          lo = 128; hi = 191
          n--
        }
      }
    }
    END { if (bad || n != 0) exit 1; exit 0 }
  '; then
    printf '1'
  else
    printf '0'
  fi
}

# A TERMINAL ROW'S LIVENESS COLUMNS ARE FROZEN — and ONLY those two.
#
# Cancelling a build (`/code stop`, board X-cancel) writes the terminal phase but
# does NOT kill the detached workflow that was building it (rjunee/neutron#177):
# the workflow keeps going and its next per-phase checkpoint would land
# `subagent_status='running'` plus a fresh `last_advanced_at` back onto the
# terminal row — re-creating exactly the stale "still running" claim
# `TridentRunStore.terminalTransition` retracts, and re-stamping the heartbeat of a
# finished run. Terminal-set literal identical to the store's TERMINAL_PHASE_SQL
# (trident/store.ts) and `state-machine.ts` TERMINAL_PHASES — pinned against them
# by trident/inner-workflow.test.ts, since this is a fourth copy of that set.
#
# The freeze is SCOPED, not a blanket refusal of the whole write, because the
# orphan's `branch`/`pr`/`inner_checkpoint`/`inner_result`/`inner_verdict` are the
# only trail back to work it did AFTER the cancel — a PR it opened, a branch it
# pushed. Dropping those would leave an untraceable orphan PR and no row pointing
# at it — on a FIRST launch this script is the ONLY writer of either: the launch
# persist carries `branch`/`pr` forward but cannot invent them (a fresh run has
# `branch = null`, and `detectExistingPr` probes `trident/<slug>`, which does not
# exist yet — trident/orchestrator.ts `launch`). Which matters precisely BECAUSE
# #177 leaves the workflow alive. They are inert on a terminal
# row — `advanceTridentRun`'s `step()` no-ops on it (trident/orchestrator.ts), so
# nothing resumes from a checkpoint or harvests a result — but they stay readable,
# and `run-progress.ts` surfaces `pr` to the board. A cancelled row carrying a
# stale parseable `inner_result` is already an ANTICIPATED state, not a new one:
# `isTridentHarvestTerminal` keys on the durable `harvested_at` marker, which
# `terminalTransition` never sets, precisely so such a row emits no handoff
# (trident/orchestrator.ts, RC2).
#
# `frozen <column> <new-value-sql>` → the new value on an active row, the OLD
# value on a terminal one.
terminal_phases="('done', 'failed', 'stopped')"
frozen() {
  printf 'CASE WHEN phase IN %s THEN %s ELSE %s END' "$terminal_phases" "$1" "$2"
}

# THE CANONICAL CHECKPOINT → PHASE TABLE, mirrored from
# `trident/checkpoint-phase.ts` (`phaseForCheckpoint`) and pinned against it by
# `trident/checkpoint-phase.test.ts`, which parses the case arms below out of THIS
# file and asserts both copies answer identically for every checkpoint name the
# inner workflow can emit. Read that module's header for the measurement that
# motivated this; the short version is that `phase` never moved off `forge-init`
# for the entire life of a build, and this script is the ONLY writer positioned to
# fix that — the inner workflow checkpoints by invoking this script, not through
# `TridentRunStore.update`, so a TypeScript-side derivation would never see the
# live transitions that matter.
#
# Empty output means "this checkpoint implies NOTHING about the phase" and the
# column is left untouched. That is the answer for terminal-adjacent names
# (`pr-merged`, and the throw-path `inner-error`/`awaiting-trailer`), for the
# outer loop's own markers, and for any name this table has never seen — an
# unrecognised checkpoint must not assert a phase nobody chose.
#
# THE ROUND-CARRYING SHAPES ARE MATCHED BY REGEX, NOT BY GLOB, AND THE DIGIT RUN IS
# UNBOUNDED (Argus r8). The three enumerated globs this replaces —
# `fix-round-[0-9]`, `[0-9][0-9]`, `[0-9][0-9][0-9]` — stopped at three digits,
# so `fix-round-1000` left `phase` untouched here while `phaseForCheckpoint`
# (`/^fix-round-\d+$/`) answered `argus`: a silent divergence at the four-digit
# boundary in a table whose whole claim is that the two copies are TOTALLY
# equivalent, not equivalent over the corpus someone happened to write. The bound
# that DOES belong is `round_for_checkpoint`'s nine digits, and it belongs there
# alone: that parser does arithmetic (`10#N` wraps at 2^63) and this one does not —
# it only names a phase. Bash `case` cannot express "one or more digits" without
# `extglob`, which must be enabled before the `case` is PARSED and so cannot be
# scoped to a function the equivalence test extracts and runs on its own; `[[ =~ ]]`
# with the pattern in a variable is the same construct `round_for_checkpoint` uses
# for the same reason (macOS bash 3.2 treats a quoted `=~` pattern as literal).
phase_for_checkpoint() {
  local name="$1"
  case "$name" in
    forge-done | argus-approved) printf 'argus' ; return ;;
    argus-request-changes) printf 'forge-fix' ; return ;;
    ralph-task-built) printf 'ralph-task' ; return ;;
  esac
  local fix_re='^fix-round-[0-9]+$'
  local rc_re='^argus-request-changes-round-[0-9]+$'
  # `[0-9]` IS COLLATED, NOT ASCII, under a UTF-8 locale — the same measurement
  # `round_for_checkpoint` below carries (Argus r23), and it needs the same pin here.
  # Under glibc `en_US.UTF-8` the class also matches U+0663 ARABIC-INDIC DIGIT THREE,
  # so `fix-round-٣` MATCHED `$fix_re` and this mirror answered `argus` while
  # `phaseForCheckpoint` answers null — two copies of one rule disagreeing about a
  # row's phase under nothing but the ambient locale of the host that happened to run
  # the write. `LC_ALL=C` for the duration of the two tests makes the class the ten
  # ASCII digits both copies mean, so a non-ASCII digit falls through to "no phase",
  # which is what the TypeScript copy says about it.
  local saved_lc="${LC_ALL-}"
  LC_ALL=C
  local phase=''
  if [[ "$name" =~ $fix_re ]]; then
    phase='argus'
  elif [[ "$name" =~ $rc_re ]]; then
    phase='forge-fix'
  fi
  if [ -n "$saved_lc" ]; then LC_ALL="$saved_lc"; else unset LC_ALL; fi
  printf '%s' "$phase"
}

# THE CANONICAL CHECKPOINT -> ROUND PARSER, mirrored from
# `trident/checkpoint-round.ts` (`checkpointRound`) and pinned against it by the
# equivalence suite in `trident/checkpoint-round.test.ts`, exactly the way
# `phase_for_checkpoint` above is pinned by `checkpoint-phase.test.ts`.
#
# EXACTLY TWO SHAPES CARRY A ROUND - everything else prints empty, meaning "this
# checkpoint implies NOTHING about the round" and the column is left untouched:
#   `fix-round-N`                                                      -> N
#   `outer-published:<40-lowercase-hex>:<remaining>:<round>[:deviated]` -> <round>
# The round is the LAST numeric field of the published shape (the publisher builds
# outer-published:<head>:<remaining_tasks>:<round>), never the first.
# `argus-request-changes-round-N` also names a round and is DELIBERATELY not
# parsed: the TS copy enumerates those two shapes and forbids guessing, so this
# one must forbid the same.
#
# AT MOST NINE DIGITS, matching the TS copy's identical bound. `$(( 10#N ))` WRAPS
# at 2^63 - `fix-round-9223372036854775808` evaluated to -9223372036854775808 and
# that minus sign went straight into `round=MAX(round, -N)`, while the TS copy
# returned the mathematical value. Clamping the DOMAIN in the pattern is what makes
# the cross-language equivalence total rather than true only over the test corpus:
# outside nine digits neither copy matches and the column is left untouched. A real
# round is bounded by `max_rounds`, so nothing legitimate is excluded.
#
# The regexes live in VARIABLES because macOS bash 3.2 treats a quoted `=~`
# pattern as literal text.
round_for_checkpoint() {
  local name="$1"
  # TRIMMED FIRST, because the TypeScript copy trims (`checkpoint-round.ts`) and
  # the equivalence claim is TOTAL, not "total over the names a writer happens to
  # emit today": ' fix-round-3 ' answered 3 there and '' here.
  #
  # THE SIX ASCII CHARACTERS ARE SPELLED OUT, not `[[:space:]]` (Argus r4). That
  # class is LOCALE-DEPENDENT: measured on glibc en_US.UTF-8, it also matches
  # U+2003 EM SPACE, so this copy answered 3 for a name `checkpoint-round.ts`
  # (narrowed to `[\t\n\v\f\r ]`) and the canonical disposition SQL (`TRIM(col,
  # ' '||CHAR(9)||CHAR(10)||CHAR(11)||CHAR(12)||CHAR(13))`) both decline — and the
  # answer changed with the ambient LANG, which is not a property a durable write
  # rule may have. Spelled out, all three copies trim the same set on every host.
  local ws_re=$'^[ \t\n\v\f\r]*(.*[^ \t\n\v\f\r])?[ \t\n\v\f\r]*$'
  if [[ "$name" =~ $ws_re ]]; then name="${BASH_REMATCH[1]}"; fi
  local fix_re='^fix-round-([0-9]{1,9})$'
  local pub_re='^outer-published:[0-9a-f]{40}:[0-9]+:([0-9]{1,9})(:deviated)?$'
  # `[0-9]` IS COLLATED, NOT ASCII, under a UTF-8 locale (Argus r23, two repros).
  # On glibc `en_US.UTF-8` it also matches U+0663 ARABIC-INDIC DIGIT THREE, so
  # `fix-round-٣` MATCHED here and then `$(( 10#٣ ))` threw "invalid integer
  # constant" — under `set -euo pipefail` that aborts the whole invocation and the
  # ENTIRE checkpoint UPDATE is lost, i.e. exactly the blind row this script's
  # docblock forbids. (`phase_for_checkpoint` above now carries the same pin for the
  # same reason; there the missing one cost a mis-derived phase column rather than an
  # aborted write.) `LC_ALL=C` for the duration of the two tests makes the class
  # the ten ASCII digits the arithmetic can actually read, so a non-ASCII digit
  # falls to the `else` and answers "not a round-bearing name", which is the same
  # answer `checkpointRound` and the canonical SQL give it.
  local saved_lc="${LC_ALL-}"
  LC_ALL=C
  local matched=0
  if [[ "$name" =~ $fix_re ]] || [[ "$name" =~ $pub_re ]]; then matched=1; fi
  if [ -n "$saved_lc" ]; then LC_ALL="$saved_lc"; else unset LC_ALL; fi
  if [ "$matched" = 1 ]; then
    # `10#` normalizes leading zeros (base-10, not octal), so `fix-round-007`
    # answers 7 - the same value Number('007') gives the TypeScript copy.
    printf '%s' "$(( 10#${BASH_REMATCH[1]} ))"
  else
    printf ''
  fi
}

sets=()
derived_phase=''
derived_round=''
verdict_value=''
verdict_given=0
findings_given=0
guarded_rejection=0
demoted_rejection=0
# A verdict that BRINGS NO FINDINGS was asked for (a bare `REVIEW_NOT_RUN`, or a
# verdict paired with an emptying findings file); the row may already hold a
# settled rejection, in which case the write is frozen and has to say so.
frozen_no_review=0
# How that frozen write described itself, for the report at the end.
frozen_label=''
# The EFFECTIVE findings this write leaves on the row, as a SQL expression. Default
# is the row's own column: SQLite evaluates every RHS against the OLD row, so this
# reads what is already recorded when the invocation does not bring findings of its
# own — exactly the precedence the store's guard uses (`patch ?? row`).
findings_expr='inner_checkpoint_findings'
# The UTF-8 well-formedness test for whatever `findings_expr` ends up being. While
# it is the column, only SQL can answer, and above the scan's ceiling it answers 0:
# the question this expression feeds is "may this write record a REJECTION", and a
# value too large to verify does not justify one. `settled_rejection` below asks the
# OTHER question of the same column — "must I refuse to ERASE this row's findings" —
# and passes 1 there, because both answers are the fail-closed one for their own
# question. A findings FILE replaces this with a linear verdict over its bytes.
findings_utf8="$(utf8_wellformed inner_checkpoint_findings 0)"
# The "this write would erase a settled rejection" SQL predicate, built below the
# loop (it needs to know whether a verdict was also given). Empty means the guard
# does not apply to this invocation at all.
erasure=''
stamps_liveness=0
while [ "$#" -gt 0 ]; do
  field="$1"
  if [ "$#" -lt 2 ]; then
    echo "checkpoint.sh: missing value for field '$field'" >&2
    exit 2
  fi
  value="$2"
  shift 2
  case "$field" in
    pr)
      stamps_liveness=1
      case "$value" in
        '' | *[!0-9]*)
          echo "checkpoint.sh: pr must be a non-negative integer, got '$value'" >&2
          exit 2
          ;;
      esac
      sets+=("pr=$value")
      ;;
    subagent_status)
      stamps_liveness=1
      # LIVENESS — frozen on a terminal row.
      sets+=("subagent_status=$(frozen subagent_status "'$(sql_quote "$value")'")")
      ;;
    brief_alert)
      # Durable observability only. Recording an already-detected refusal must
      # not make a stalled build look as though its workflow advanced.
      sets+=("brief_alert='$(sql_quote "$value")'")
      ;;
    inner_verdict)
      stamps_liveness=1
      # DEFERRED to the block below the loop, NOT written here: a REQUEST_CHANGES
      # verdict is only legal alongside findings, and the findings may be supplied
      # by a LATER argument in this same invocation. See "THE VERDICT WRITE".
      verdict_given=1
      verdict_value="$value"
      ;;
    branch | inner_checkpoint | inner_checkpoint_head)
      stamps_liveness=1
      # `inner_checkpoint_head` is the branch head OID the checkpoint APPLIES TO,
      # and the workflow writes it in the SAME invocation as `inner_checkpoint`
      # so the name and the commit can never drift apart. An EMPTY value is a
      # legitimate write, not a no-op: it CLEARS a previous checkpoint's OID so a
      # phase that could not report a sha never inherits the last one's.
      sets+=("$field='$(sql_quote "$value")'")
      # A checkpoint that NAMES a live phase also writes it — see the phase block
      # below the loop for why this script is the only place that can.
      if [ "$field" = inner_checkpoint ]; then
        derived_phase="$(phase_for_checkpoint "$value")"
        derived_round="$(round_for_checkpoint "$value")"
      fi
      ;;
    inner_findings_file)
      stamps_liveness=1
      # The synthesised findings the checkpoint was recorded with, materialised
      # ONCE by `read_file_literal` (see there for why re-reading is not an option:
      # the verdict CASE below mentions this expression five times). A missing file
      # yields SQL NULL → no recorded findings → a resume re-reviews rather than
      # fixing blind. NOT a liveness column: no freeze, and no `subagent_status`
      # side effect (a mid-run checkpoint is not a result).
      findings_given=1
      # Read ONCE, here rather than through `read_file_literal`, because the UTF-8
      # gate is decided from these same bytes (see `utf8_wellformed`) and a second
      # read could see a different file than the one stored.
      if [ -f "$value" ] && [ -r "$value" ]; then
        findings_bytes="$(cat -- "$value" 2>/dev/null; printf X)"
        findings_bytes="${findings_bytes%X}"
        findings_expr="$(literal_of "$findings_bytes")"
        findings_utf8="$(utf8_verdict "$findings_bytes")"
      else
        findings_expr='NULL'
        findings_utf8=''
      fi
      # No `iconv` on this host: fall back to the SQL scan, whose above-the-ceiling
      # answer on a literal is 0 — a rejection this script cannot verify is not one.
      if [ -z "$findings_utf8" ]; then
        findings_utf8="$(utf8_wellformed "$findings_expr" 0)"
      fi
      # The column write itself is DEFERRED to the verdict block below, for the
      # same reason the verdict write is: what this write may do to a terminal
      # row's recorded findings depends on whether the invocation also carries a
      # verdict, and that is not known until the whole argument list is read.
      ;;
    inner_result_file)
      stamps_liveness=1
      # Materialised once, for the same reason the findings are: the column and the
      # status CASE below both read it, and two `readfile()` evaluations of one path
      # inside one UPDATE can see different bytes — which here would flip
      # `subagent_status` to 'completed' beside an EMPTY `inner_result`.
      f="$(read_file_literal "$value")"
      sets+=("inner_result=$f")
      # Two guards, outermost first: the terminal freeze, then the original
      # column-consistency CASE (flip to 'completed' ONLY when the SAME bytes just
      # stored are non-empty text).
      sets+=("subagent_status=CASE WHEN phase IN $terminal_phases THEN subagent_status WHEN length($f) > 0 THEN 'completed' ELSE subagent_status END")
      ;;
    *)
      echo "checkpoint.sh: unknown field '$field'" >&2
      exit 2
      ;;
  esac
done

# THE PHASE WRITE — frozen on a terminal row, and the freeze is load-bearing in a
# way the liveness columns' is not.
#
# `phase` is the ONLY column here that drives control flow. `isTerminalPhase(phase)`
# is what stops the tick driver loading a run (`tick.ts`), what makes
# `advanceTridentRun`'s step a no-op (`orchestrator.ts`), and what keeps a stopped
# run out of the active-lane budget (`active-runs.ts`). Cancelling a build does NOT
# kill the detached workflow that was building it (rjunee/neutron#177) — the
# workflow keeps going and keeps checkpointing. Writing `phase` unguarded would
# therefore let a cancelled run's own orphaned workflow flip `stopped` back to
# `argus` and RESURRECT it: re-loaded by the driver, re-driven, re-merged. That is
# strictly worse than the stale liveness claim the existing freeze retracts, which
# is only ever a display lie.
#
# So the freeze is reused deliberately rather than a phase-specific guard being
# invented: identical terminal set, identical CASE, one thing to keep true.
if [ -n "$derived_phase" ]; then
  sets+=("phase=$(frozen phase "'$(sql_quote "$derived_phase")'")")
fi

# THE ROUND WRITE - monotonic, and NOT frozen on a terminal row.
#
# Same rule as the store's TypeScript seam (`trident/store.ts` update() derives it
# via `checkpointRound` and writes `round = MAX(round, ?)`, never lowering it).
# That seam was the ONLY one deriving anything: the live inner workflow does not
# go through `TridentRunStore.update` - it invokes THIS script - so `round` stayed
# at its launch value for 215 of the 224 runs measured in the 30 days to
# 2026-08-31 while their own `inner_checkpoint` recorded fix-round-2..7.
#
# The regex above proved `$derived_round` is at most nine digits, so `10#` cannot
# wrap it negative and the bare interpolation is SQL-safe pure digits.
#
# DELIBERATELY NOT FROZEN, unlike `phase`: `round` is EVIDENCE - the same class as
# `branch`/`pr`/`inner_checkpoint`, which this script records on a terminal row on
# purpose so an orphaned workflow (rjunee/neutron#177) leaves a readable trail. It
# drives no control flow here, and MAX means it can only ever rise.
if [ -n "$derived_round" ]; then
  sets+=("round=MAX(round, $derived_round)")
fi

# THE VERDICT WRITE — a REJECTION MUST STATE A REASON, enforced HERE because this
# script is a WRITE SITE, not a caller.
#
# The measurement this closes: 97 of 160 recorded `REQUEST_CHANGES` rows in the 30
# days to 2026-08-31 carried NO findings — the verdict was what got stamped when a
# run ended any other way. `trident/store.ts` already refuses that shape for
# in-process writers (`TridentEmptyFindingsRejectionError`), but the LIVE inner
# workflow does not go through the store: it invokes THIS script, which accepted
# `inner_verdict REQUEST_CHANGES` as a plain settable and left the findings column
# NULL. A precondition only one of two write sites honours is not a precondition.
#
# REFUSED, NOT FAILED, and the difference is the whole point: the run really did
# end, and losing the rest of this write (branch, checkpoint, result) to an error
# exit would trade one bad column for a blind row. So the rejection is refused and
# THE TRUE STATE IS RECORDED INSTEAD — `REVIEW_NOT_RUN`, the distinct terminal for
# "no reviewer spoke about this code". Never APPROVE: that would merge unreviewed
# work, which is far worse than the waste being fixed.
#
# The test is `parseCheckpointFindings` (trident/checkpoint-findings.ts) expressed
# in SQL by `findings_case` above — well-formed JSON, an ARRAY, at least one
# element — evaluated inside the SAME atomic UPDATE, so no other writer can slip
# between the check and the write. The findings expression is a MATERIALISED
# LITERAL (`read_file_literal`), so the four places it appears are provably the
# same bytes; a bare `readfile()` was re-evaluated per mention and let a
# concurrently-swapped file persist the exact `REQUEST_CHANGES` + `[]` row this
# block exists to make unwritable (Argus r8 blocker, reproduced).
# THE FIELD WAS GIVEN, not merely non-empty: an EMPTY `inner_verdict ''` is a
# CLEARING write, exactly as it is for `inner_checkpoint_head`, and deferring the
# write must not quietly turn it into a no-op the way an `-n` test on the value did.
#
# A CLEARING WRITE IS SQL NULL, NOT THE EMPTY STRING (Argus r4). The production
# schema constrains the column — `CHECK (inner_verdict IS NULL OR inner_verdict IN
# ('APPROVE','REQUEST_CHANGES','REVIEW_NOT_RUN'))`, migrations/expected-schema.txt —
# so `inner_verdict=''` is not a value the column can hold: SQLite aborts the WHOLE
# atomic UPDATE with "CHECK constraint failed", and branch/checkpoint/round/result
# go down with it. That is precisely the blind row this script refuses to trade one
# bad column for, so "cleared" is expressed the only way the schema accepts it.
#
# AND `json_valid` CARRIES A NESTING BOUND THE TS SIDE HAD TO BE TOLD ABOUT:
# SQLite enforces JSON_MAX_DEPTH (1000 at the default compile) — depth 1000 is
# valid and depth 1001 measures `json_valid(...) = 0` on 3.45.1, while JSON.parse
# has no such limit. `parseCheckpointFindings` (trident/checkpoint-findings.ts)
# now enforces the SAME bound explicitly, so this writer, the store's write-site
# guard and the canonical counting SQL agree at the boundary instead of splitting
# one row three ways — pinned by the corpus in as-built-disposition-sql.test.ts
# and by the deep-nesting entry in the checkpoint-sh empties.
#
# AND THE PRECONDITION IS ON THE ROW, NOT ON THE INVOCATION (Argus r8 blocker).
# Guarding only the invocations that CARRY a verdict left a second way to the same
# forbidden row: record a real rejection, then write findings ALONE that empty the
# set, and `REQUEST_CHANGES` sits beside `[]` — the state the whole card exists to
# make unreachable, reached in two legal steps. `TridentRunStore.update` already
# refuses that shape (it re-reads the row and tests the EFFECTIVE verdict against
# the EFFECTIVE findings), so leaving it writable here is exactly the "precondition
# only one of two write sites honours" this block was added to end. A findings-only
# write therefore DEMOTES a stored `REQUEST_CHANGES` the same way a verdict write is
# refused — same test, same `REVIEW_NOT_RUN`, same never-APPROVE. The demotion is
# conditioned on the OLD `inner_verdict` inside the same atomic UPDATE, so it can
# only ever touch a row that is currently claiming a rejection: an `APPROVE` row and
# a null-verdict row are left exactly alone.
#
# AND A SETTLED REJECTION IS NOT ERASED BY AN ORPHAN (Argus r1). The demotion above
# is right for a LIVE row and wrong for a terminal one, because of who writes on
# each. `artifactCheckpointCommand` (trident/inner-workflow.mjs) opens EVERY phase
# checkpoint with `printf '%s' '[]' > <findings tmp>` and passes it as
# `inner_findings_file` with no verdict — a findings-only write that empties the
# set. Cancelling a build does not kill the workflow building it
# (rjunee/neutron#177), so one of those lands on a row that has already recorded a
# REAL, findings-carrying REQUEST_CHANGES: the demotion then rewrites a genuine
# rejection to `REVIEW_NOT_RUN` and drops the reviewer's own words, and the
# resulting no-review row is what `terminalRunDisposition` reads as
# built-never-reviewed and re-dispatches. The reviewer decided; an orphan may not
# undecide it.
#
# So on a TERMINAL row, an EMPTYING findings-only write is refused ON BOTH COLUMNS
# TOGETHER — the findings stay, and so does the verdict they justify. Both are
# guarded by ONE expression evaluated inside the same atomic UPDATE, so the pair
# can never disagree; this is the same reasoning as the `phase` freeze rather than
# the liveness one, since `inner_verdict` is what the disposition reads to decide
# whether the work is replayed. It is deliberately NARROW:
#   * a LIVE row demotes exactly as before (the live shape a `fix-round-N`
#     checkpoint has, and the case the existing tests pin);
#   * findings that are REALLY there still land on a terminal row — only ERASURE is
#     refused, so an orphan may still add evidence, never delete it;
#   * an invocation carrying a verdict OTHER than `REQUEST_CHANGES` is a caller
#     deciding something new, and is left on the rules above.
#
# A VERDICT-CARRYING ORPHAN IS STILL AN ORPHAN (Argus r16). The guard first armed
# only when NO verdict was given, so `inner_verdict REQUEST_CHANGES` + `[]` — the
# same emptying write with a verdict stapled on — walked straight past it and
# demoted a settled terminal rejection to `REVIEW_NOT_RUN` with its findings
# erased, which is the exact row `terminalRunDisposition` re-reads as
# built-never-reviewed, i.e. as work to re-dispatch. That write asks for the ONE
# verdict this script refuses to write findings-free, so it can never be a caller
# deciding anything: it is either the orphan again or a caller re-asserting what
# the row already says. Either way the settled row is left alone. `APPROVE` and a
# clearing write are untouched — a real decision still lands.
#
# AND THE EVIDENCE IS PROTECTED WHATEVER THE ROW CLAIMS. A terminal row whose
# stored findings PARSE non-empty keeps them even when its verdict is
# `REVIEW_NOT_RUN` or `APPROVE`: `orchestrator.ts` (`recordedTerminalVerdict`)
# promises exactly that — "the findings themselves are still PRESERVED on the
# row" — and `builtButNeverReviewedSeed` carries the stored findings forward into
# the seeded run, so an orphan's `[]` did not just blank a display column, it
# handed the next round a review with nothing in it (Argus r16). Adding evidence
# is still allowed; only ERASURE is refused.
#
# AND THE GUARD ARMS ON THE ROW'S CLAIM, NOT ON ITS EVIDENCE (Argus r15). It first
# also required the STORED findings to parse non-empty, which left the whole legacy
# population — the 70 `REQUEST_CHANGES` + `[]` and 27 `REQUEST_CHANGES` + NULL rows
# this card measured — outside it: an orphan `[]` write demoted a settled terminal
# rejection to `REVIEW_NOT_RUN`, and `terminalRunDisposition` then re-read that row
# as built-never-reviewed, i.e. as work to re-dispatch. Those rows are the
# measurement's evidence base and the card forbids rewriting them, so a TERMINAL row
# CLAIMING `REQUEST_CHANGES` is left exactly as history wrote it whatever it holds:
# an emptying orphan write changes neither column. Nothing here creates the
# forbidden shape — a row can only reach terminal-REQUEST_CHANGES-with-no-findings
# through history or raw SQL, because both write sites refuse to write it — this
# only declines to REWRITE one, and it stays countable as legacy by the canonical
# SQL either way.
# WHAT "SETTLED" MEANS, read from the OLD row inside the same atomic UPDATE: a
# TERMINAL row that either CLAIMS a rejection or HOLDS findings that really parse.
# Both erasure guards below are this predicate plus "…and what this write brings is
# not findings".
settled_rejection="phase IN $terminal_phases AND (inner_verdict = 'REQUEST_CHANGES' OR $(findings_case inner_checkpoint_findings 1 0 "$(utf8_wellformed inner_checkpoint_findings 1)") = 1)"
# "…and what this write BRINGS is not findings" — the second half of every guard
# below. An invocation with no findings file of its own brings nothing by
# definition; one with a file brings nothing when that file does not parse as a
# non-empty array. Same expression for both erasure guards, so the findings column
# and the verdict column can never disagree about whether this write had evidence.
brings_no_findings='1 = 1'
# AND THE VERDICT IT CARRIES DOES NOT EXEMPT IT (Argus r20, two independent
# repros). The arming used to require the verdict be ABSENT or `REQUEST_CHANGES`,
# so `inner_verdict APPROVE` + `[]` and `inner_verdict REVIEW_NOT_RUN` + `[]` —
# the same emptying write with any other verdict stapled on — walked past it and
# blanked a settled rejection's findings, contradicting the invariant stated right
# above ("only ERASURE is refused"). The findings column is now guarded for EVERY
# shape that brings no findings; which verdicts additionally freeze is decided
# per-verdict below.
if [ "$findings_given" = 1 ]; then
  brings_no_findings="$(findings_case "$findings_expr" 1 0 "$findings_utf8") = 0"
  # "This write would ERASE a settled review": the row is terminal, it is either
  # claiming REQUEST_CHANGES or holding findings that really parse, and what this
  # write brings is not findings. Both halves of the OR are read from the OLD row
  # inside the same atomic UPDATE, so the pair cannot disagree with each other or
  # with the columns they guard.
  erasure="$settled_rejection AND $brings_no_findings"
fi

if [ "$findings_given" = 1 ]; then
  if [ -n "$erasure" ]; then
    sets+=("inner_checkpoint_findings=CASE WHEN $erasure THEN inner_checkpoint_findings ELSE $findings_expr END")
  else
    sets+=("inner_checkpoint_findings=$findings_expr")
  fi
fi

if [ "$verdict_given" = 1 ]; then
  if [ "$verdict_value" = 'REQUEST_CHANGES' ]; then
    guarded_verdict="$(findings_case "$findings_expr" "'REQUEST_CHANGES'" "'REVIEW_NOT_RUN'" "$findings_utf8")"
    # …unless this write would erase a settled review, in which case the row keeps
    # both columns exactly as it recorded them (see the erasure block above).
    if [ -n "$erasure" ]; then
      guarded_verdict="CASE WHEN $erasure THEN inner_verdict ELSE $guarded_verdict END"
    fi
    sets+=("inner_verdict=$guarded_verdict")
    guarded_rejection=1
  elif [ -z "$verdict_value" ]; then
    # AND THE CLEARING WRITE IS NOT AN EXIT EITHER (Argus r21). `inner_verdict ''`
    # was the one shape that walked straight past both guards: on a settled
    # terminal row it NULLed the verdict while the findings column — guarded by the
    # erasure block above — kept the real findings, leaving the two columns
    # disagreeing about whether a review happened, which is exactly the state this
    # script's docblock promises can never occur. `terminalRunDisposition` then
    # reads a reviewed rejection as died-before-build and the card is re-dispatched
    # from scratch: the same waste this card removes, reached by clearing instead
    # of overwriting. Frozen on the SAME terms as its `REVIEW_NOT_RUN` sibling —
    # only a TERMINAL, already-settled row, and only when the write brings no
    # findings of its own. A live row, and a clear that carries REAL findings, both
    # land unchanged.
    #
    # No production path emits it today (`inner-workflow.mjs` writes only
    # APPROVE/REQUEST_CHANGES/REVIEW_NOT_RUN), so this closes the shape rather than
    # a live regression — which is the point of putting the rule at the WRITE SITE:
    # a future caller cannot reach the erasure by choosing a different argument.
    sets+=("inner_verdict=CASE WHEN $settled_rejection AND $brings_no_findings THEN inner_verdict ELSE NULL END")
    frozen_no_review=1
    if [ "$findings_given" = 1 ]; then
      frozen_label='a verdict-clearing write with an emptying findings file'
    else
      frozen_label='a bare verdict-clearing write'
    fi
  elif [ "$verdict_value" = 'REVIEW_NOT_RUN' ]; then
    # AND THE ERASURE GUARD COVERS THE VERDICT-ONLY WRITE TOO (Argus r18). The block
    # above arms `$erasure` only when a findings file accompanies the write, so a BARE
    # `inner_verdict REVIEW_NOT_RUN` slipped past it and overwrote a settled terminal
    # rejection — and that is not a hypothetical shape: `writeTerminalResult`
    # (inner-workflow.mjs) emits exactly it for every non-code terminal, so a late
    # duplicate terminal write on an already-settled row demoted a real review to
    # "no review happened". `terminalRunDisposition` then re-reads that row as
    # built-never-reviewed, i.e. as work to re-dispatch — the precise waste this card
    # exists to remove, arrived at from the other direction.
    #
    # Scoped exactly like its twin: only with NO findings to bring, and only against
    # a TERMINAL row that is already settled. A non-terminal row, a clearing write
    # and a `REVIEW_NOT_RUN` that carries REAL findings all land unchanged, and the
    # FIRST honest `REVIEW_NOT_RUN` — the one on a row that never claimed a
    # rejection — is exactly what still gets written.
    #
    # AND A FINDINGS FILE STAPLED ON DOES NOT EXEMPT IT EITHER (Argus r20). The
    # arming above also required `findings_given = 0`, so `REVIEW_NOT_RUN` + `[]`
    # fell through to the unguarded write below and demoted the same settled row —
    # the identical erasure, one argument longer. The freeze now asks the same
    # question the findings column asks: does this write BRING findings? A
    # `REVIEW_NOT_RUN` carrying REAL findings is adding evidence and still lands,
    # verdict and findings both.
    sets+=("inner_verdict=CASE WHEN $settled_rejection AND $brings_no_findings THEN inner_verdict ELSE 'REVIEW_NOT_RUN' END")
    frozen_no_review=1
    if [ "$findings_given" = 1 ]; then
      frozen_label='a REVIEW_NOT_RUN with an emptying findings file'
    else
      frozen_label='a bare REVIEW_NOT_RUN'
    fi
  elif [ -n "$erasure" ]; then
    # EVERY OTHER VERDICT, WHEN THE WRITE BRINGS NO FINDINGS (Argus r20). In
    # practice this is `APPROVE` + `[]`, which a reviewer reproduced turning a
    # settled `REQUEST_CHANGES` into an APPROVE with its findings blanked. No
    # production path emits it: `writeTerminalResult` attaches a findings file
    # ONLY on its REQUEST_CHANGES branch, and `artifactCheckpointCommand` never
    # sends a verdict at all — so a verdict arriving WITH an emptying findings file
    # is an orphan or a re-assertion, never a review deciding something new. A real
    # APPROVE carries no findings file and lands exactly as before (the branch
    # below), which is why freezing here relaxes nothing and un-decides nothing.
    sets+=("inner_verdict=CASE WHEN $erasure THEN inner_verdict ELSE '$(sql_quote "$verdict_value")' END")
    frozen_no_review=1
    frozen_label="the verdict '$verdict_value' with an emptying findings file"
  else
    # A BARE VERDICT THAT IS NOT ONE OF THE THREE ABOVE — in practice `APPROVE`,
    # with no findings file at all. It lands, and that is a DECISION, not an
    # oversight (Argus r23, minor, reproduced): freezing it against a settled
    # terminal rejection was considered and rejected, because the shape it would
    # catch and the shape it would break are the same row. A row can only be
    # terminal-and-rejected while its own workflow is still writing if the outer
    # loop REAPED it mid-round; the workflow then approves round N+1 and this write
    # is the only thing that corrects the row. Freezing would leave a run that was
    # reviewed and approved recorded as a rejection — the same "real rejections"
    # count skewed the other way, and worse, `terminalRunDisposition` would read it
    # `reviewed-rejected` and decline the salvage seed, rebuilding work that exists.
    # An APPROVE cannot merge anything from here (terminal rows never re-enter
    # `applyResult`), so the only stake is the count, and the count is more honest
    # taking the last thing a reviewer actually said. The ERASING shapes — a verdict
    # arriving WITH an emptying findings file, a bare `REVIEW_NOT_RUN`, a
    # verdict-clearing write — are all frozen above, because those bring no review
    # at all; this one brings a verdict a reviewer reached.
    sets+=("inner_verdict='$(sql_quote "$verdict_value")'")
  fi
elif [ "$findings_given" = 1 ]; then
  demotion="CASE WHEN inner_verdict = 'REQUEST_CHANGES' THEN $(findings_case "$findings_expr" "'REQUEST_CHANGES'" "'REVIEW_NOT_RUN'" "$findings_utf8") ELSE inner_verdict END"
  if [ -n "$erasure" ]; then
    demotion="CASE WHEN $erasure THEN inner_verdict ELSE $demotion END"
  fi
  sets+=("inner_verdict=$demotion")
  demoted_rejection=1
fi

# Both legacy progress UPDATEs unconditionally re-stamped last_advanced_at. It is
# the hang watchdog's heartbeat, so it is LIVENESS — frozen on a terminal row.
# A brief-alert-only write is excluded: detecting corruption records evidence but
# does not prove the detached workflow made progress.
#
# MILLISECONDS, NOT WHOLE SECONDS, and the reason is the wake-on-change watcher.
# `TridentRunStore.changeSignature()` builds a PER-RUN signature — one
# `id:last_advanced_at` entry per active run — so an out-of-process checkpoint is
# detected as a change to ITS OWN row's stamp. Two checkpoints on the same row
# inside the SAME second still collapse into one signature, and the second one
# would wait out the 90 s backstop — the exact latency the watcher exists to
# remove. The store's own
# writes have always been `toISOString()` (millisecond) precision; this makes the
# two writers agree. `%3N` is a GNU `date` extension: BSD/macOS `date` echoes it
# literally, so the result is validated and falls back to the original
# whole-second stamp, which is still a correct (if coarser) ISO-8601 UTC instant.
now_iso="$(date -u +%FT%T.%3NZ 2>/dev/null || true)"
case "$now_iso" in
  *[0-9].[0-9][0-9][0-9]Z) : ;;
  *) now_iso="$(date -u +%FT%TZ)" ;;
esac
if [ "$stamps_liveness" -eq 1 ]; then
  sets+=("last_advanced_at=$(frozen last_advanced_at "'${now_iso}'")")
fi

set_clause="$(printf '%s, ' "${sets[@]}")"
set_clause="${set_clause%, }"

quoted_run="$(sql_quote "$run")"

# The verdict this row carried BEFORE the write, read only when a findings-only
# demotion is armed, and used only to decide whether the demotion diagnostic below
# is true. Diagnostics only — like the phase re-read further down, it is a separate
# statement and a concurrent writer can make it stale; the UPDATE's own CASE reads
# the OLD row inside the atomic statement and is the authority on what happens.
prior_verdict=''
if [ "$demoted_rejection" -eq 1 ]; then
  prior_verdict="$(sqlite3 -init /dev/null -list "$db" "PRAGMA busy_timeout=5000; SELECT COALESCE(inner_verdict, '') FROM code_trident_runs WHERE id='$quoted_run'" 2>/dev/null | tail -1 || true)"
fi

# A frozen write is not an error, but a missing row IS: callers must be able to
# distinguish "recorded" from "zero rows changed" even when diagnostics are
# intentionally suppressed. `changes()` cannot distinguish a freeze from a match
# here: the freeze lives in the SET
# expressions, not the WHERE clause, so a terminal row still matches and reports
# 1 change. Hence the second column, which re-reads the row's phase.
#
# The phase re-read is a SEPARATE statement from the UPDATE with no
# `BEGIN IMMEDIATE` around the pair, so a `terminalTransition` landing in between can
# make this print FROZEN for a checkpoint that actually applied. Left as-is
# deliberately: the two branches are stderr diagnostics only — the UPDATE itself is a
# single atomic statement whose outcome does not depend on this SELECT — and wrapping
# them would take a write lock for the whole read on the hot checkpoint path.
#
# busy_timeout is a per-connection PRAGMA: it MUST run in the SAME sqlite3
# invocation as the UPDATE (';'-separated), not as a separate process — `tail -1`
# drops that PRAGMA's own "5000" echo and keeps only the final SELECT. Errors
# still reach stderr and fail the script (set -e + pipefail).
#
# `-init /dev/null -list -separator '|'` pins the OUTPUT FORMAT the `case` below
# parses: an rc file setting `.mode`/`.separator`/`.output` makes both branches fall
# through silently, so a frozen or missing write would stop being reported on the one
# host where someone customised their CLI. Environment hardening, NOT a fix for a
# reproduced bug, and the difference is worth recording: on the sqlite3 this was
# measured against (3.43.2, Apple) an rc file changes the format when passed as
# `-init <file>`, but a `HOME` override does not make the CLI pick one up — so the
# failure is unreachable there and untestable without writing to a real home dir
# (see the note in trident/checkpoint-sh.test.ts). Other builds do read it.
#
# THE SQL TRAVELS ON STDIN, NOT IN argv (Argus r1 blocker). `read_file_literal`
# materialises the findings/result bytes INTO this statement, and the verdict CASE
# mentions the findings five times — so a 33 KB findings file became a 132 KB single
# argv element. Linux caps ONE argument at MAX_ARG_STRLEN (128 KiB), independent of
# the far larger total `ARG_MAX`, and `execve` answers E2BIG: `/usr/bin/sqlite3:
# Argument list too long`, exit 126, the WHOLE terminal write lost under `set -e` —
# recreating the blind "built, never reviewed" row this script exists to prevent, on
# exactly the runs whose reviews found the most to say. Reproduced by two reviewers,
# threshold bisected at ~32 KB of findings; the live corpus already holds 13,995-byte
# rows. A pipe has no such limit (SQLITE_MAX_SQL_LENGTH is 1e9 by default), and
# nothing else changes: the PRAGMA still runs on the SAME connection as the UPDATE,
# and `printf` is a bash BUILTIN, so the bytes never cross an `execve` boundary at
# all.
#
# `-bail` preserves the argv form's stop-at-first-error semantics: reading a script
# from stdin, sqlite3 otherwise CONTINUES past a failed statement (it would run the
# trailing SELECT after an aborted UPDATE and print a plausible outcome line). With
# `-bail` the process stops and exits non-zero, and `pipefail` + `set -e` fail the
# script exactly as they did before.
update_sql="PRAGMA busy_timeout=5000;
UPDATE code_trident_runs SET $set_clause WHERE id='$quoted_run';
SELECT changes(), COALESCE((SELECT CASE WHEN phase IN $terminal_phases THEN 'terminal' ELSE 'active' END FROM code_trident_runs WHERE id='$quoted_run'), 'gone');"
outcome="$(printf '%s\n' "$update_sql" | sqlite3 -init /dev/null -bail -list -separator '|' "$db" | tail -1)"
case "$outcome" in
  0'|'*)
    echo "checkpoint.sh: run '$run' not found — checkpoint NOT applied" >&2
    exit 3
    ;;
  *'|terminal')
    echo "checkpoint.sh: run '$run' is already terminal — liveness (subagent_status, last_advanced_at) FROZEN; branch/pr/checkpoint/round/result still recorded" >&2
    ;;
esac

# A REFUSED rejection must not be silent — it is the one case where the column does
# not hold what the caller asked for. Read back rather than re-deriving: the CASE
# above is the authority and this only reports what it decided. A separate
# statement on purpose (the UPDATE has already landed atomically), best-effort, and
# it can never fail the write it is describing.
if [ "$guarded_rejection" -eq 1 ] || [ "$demoted_rejection" -eq 1 ] || [ "$frozen_no_review" -eq 1 ]; then
  recorded_verdict="$(sqlite3 -init /dev/null -list "$db" "PRAGMA busy_timeout=5000; SELECT COALESCE(inner_verdict, '') FROM code_trident_runs WHERE id='$quoted_run'" 2>/dev/null | tail -1 || true)"
  if [ "$guarded_rejection" -eq 1 ] && [ "$recorded_verdict" != 'REQUEST_CHANGES' ]; then
    echo "checkpoint.sh: REFUSED a findings-free REQUEST_CHANGES for run '$run' — a rejection must carry at least one finding; recorded '$recorded_verdict' instead" >&2
  elif [ "$guarded_rejection" -eq 0 ] && [ "$prior_verdict" = 'REQUEST_CHANGES' ] && [ "$recorded_verdict" != 'REQUEST_CHANGES' ]; then
    # The findings-only half. Reported only when the demotion REALLY fired — the
    # row was claiming a rejection before this write and is not any more. A row
    # that was never REQUEST_CHANGES, and one whose new findings are real, are both
    # silent, because nothing was refused on them.
    echo "checkpoint.sh: DEMOTED a REQUEST_CHANGES whose findings this write emptied for run '$run' — a rejection must carry at least one finding; recorded '$recorded_verdict' instead" >&2
  elif [ "$frozen_no_review" -eq 1 ] && [ "$recorded_verdict" != "$verdict_value" ]; then
    # The verdict half. Same rule as its two siblings: reported only when the
    # freeze REALLY fired, i.e. the column does not hold what the caller asked for.
    echo "checkpoint.sh: FROZE $frozen_label for run '$run' — the row already records a settled review and a write bringing no findings may not erase it; kept '$recorded_verdict'" >&2
  fi
fi
