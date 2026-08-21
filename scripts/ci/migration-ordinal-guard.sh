#!/usr/bin/env bash
#
# Migration ordinal collision guard — T2 of the migration-ordinal card.
#
# Nothing allocates migration ordinals, so two branches cut from the same main
# both see the next integer as free and both take it. The runner REFUSES a
# duplicate at boot (`Migration ordinal collision at version N`, runner.ts) and
# name-reconciliation stops a drifted row refusing boot (#388) — but both of
# those fire AFTER the collision has already been merged. On 2026-08-17 that
# cost a live outage (a silently skipped ordinal shipped code writing columns
# that did not exist) and then a hand renumber of #269 when #397 took 0132
# underneath it.
#
# This is the half that runs BEFORE the merge: a PR whose migration ordinal is
# already used on origin/main, by a file of a different name, fails here.
#
# Deliberately a shell + git script, not a bun test: it must compare the branch
# against origin/main, which a unit test with no remote cannot see. It lives in
# the `layering` job because that is the one job checked out with full history.
set -euo pipefail

MIGRATIONS_DIR="${1:-migrations}"
BASE_REF="${BASE_REF:-origin/main}"
FILE_RE='^([0-9]{4})_(.+)\.sql$'

fail() { printf 'MIGRATION ORDINAL GUARD: FAIL — %s\n' "$1" >&2; exit 1; }

[ -d "$MIGRATIONS_DIR" ] || fail "no such directory: $MIGRATIONS_DIR"

# ---------------------------------------------------------------------------
# Collect this tree's ordinals. An EMPTY extraction must fail loudly: a guard
# that parses nothing reads exactly like a guard that found nothing wrong, and
# this repository has shipped that mistake more than once in a single day.
# ---------------------------------------------------------------------------
declare -A tree_name_by_ordinal=()
count=0
for path in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$path" ] || continue
  file="$(basename "$path")"
  [[ "$file" =~ $FILE_RE ]] || continue
  ordinal="${BASH_REMATCH[1]}"
  slug="${BASH_REMATCH[2]}"
  if [ -n "${tree_name_by_ordinal[$ordinal]:-}" ]; then
    fail "two migrations in this tree share ordinal $ordinal: ${tree_name_by_ordinal[$ordinal]} and $slug.
Renumber one of them to the next free ordinal and update migrations/runner.test.ts."
  fi
  tree_name_by_ordinal[$ordinal]="$slug"
  count=$((count + 1))
done

[ "$count" -gt 0 ] || fail "parsed ZERO migration files out of $MIGRATIONS_DIR — the guard is not
measuring anything. Check $FILE_RE against the real filenames before trusting a pass."

# ---------------------------------------------------------------------------
# Compare against the base branch. A ref we cannot read is NOT a pass: say so
# and stop, rather than silently skipping the only half that catches a race.
# ---------------------------------------------------------------------------
if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  fail "cannot resolve $BASE_REF — this guard needs the base branch to compare against.
In CI, check out with fetch-depth: 0."
fi

declare -A base_name_by_ordinal=()
while read -r file; do
  [ -n "$file" ] || continue
  base="$(basename "$file")"
  [[ "$base" =~ $FILE_RE ]] || continue
  base_name_by_ordinal[${BASH_REMATCH[1]}]="${BASH_REMATCH[2]}"
done < <(git ls-tree --name-only "$BASE_REF" "$MIGRATIONS_DIR/" || true)

collisions=()
for ordinal in "${!tree_name_by_ordinal[@]}"; do
  ours="${tree_name_by_ordinal[$ordinal]}"
  theirs="${base_name_by_ordinal[$ordinal]:-}"
  # Absent on base = a new ordinal, fine. Same name = the same migration we
  # already share with base, fine. A DIFFERENT name at the same ordinal is the
  # race: both branches claimed the integer.
  if [ -n "$theirs" ] && [ "$ours" != "$theirs" ]; then
    collisions+=("$ordinal|$ours|$theirs")
  fi
done

if [ ${#collisions[@]} -gt 0 ]; then
  # Next free ordinal across BOTH sides, so the remedy we print is actually free.
  next=0
  for ordinal in "${!tree_name_by_ordinal[@]}" "${!base_name_by_ordinal[@]}"; do
    value=$((10#$ordinal))
    [ "$value" -gt "$next" ] && next=$value
  done
  next=$((next + 1))
  {
    printf 'MIGRATION ORDINAL GUARD: FAIL — %d ordinal(s) already taken on %s\n\n' \
      "${#collisions[@]}" "$BASE_REF"
    for entry in "${collisions[@]}"; do
      IFS='|' read -r ordinal ours theirs <<< "$entry"
      printf '  ordinal %s\n    this branch: %s_%s.sql\n    %s:  %s_%s.sql\n\n' \
        "$ordinal" "$ordinal" "$ours" "$BASE_REF" "$ordinal" "$theirs"
    done
    printf 'The base branch got there first. Renumber this branch, do not renumber the base:\n'
    printf '  git mv %s/%s_%s.sql %s/%04d_%s.sql\n' \
      "$MIGRATIONS_DIR" "${collisions[0]%%|*}" "$(IFS='|'; set -- ${collisions[0]}; echo "$2")" \
      "$MIGRATIONS_DIR" "$next" "$(IFS='|'; set -- ${collisions[0]}; echo "$2")"
    printf '  ...update the header comment, the applied list in migrations/runner.test.ts,\n'
    printf '  and regenerate migrations/expected-schema.txt via migrations/regen-snapshot.ts.\n\n'
    printf 'Left unfixed this MERGES and then refuses boot on every instance.\n'
  } >&2
  exit 1
fi

printf 'MIGRATION ORDINAL GUARD: ok — %d migration(s) checked against %s, no ordinal claimed twice\n' \
  "$count" "$BASE_REF"
