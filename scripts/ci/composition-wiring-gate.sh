#!/usr/bin/env bash
# Composition wiring gate — a declared `enable_*` switch must be SET by a real
# composer, or not exist at all.
#
# WHY. Six features shipped built-at-both-ends-and-never-connected, every one
# with green CI, because each wiring test hand-builds the config literal the
# composer SHOULD have produced and then asserts the gate works. The gate was
# never the failing step. This checks the step that was.
#
# NOTE ON SHAPE. The findings loop reads from a REDIRECT, not a pipe. A
# `... | while read` runs the body in a subshell, so the failure flag set inside
# it is lost and the script exits 0 while printing findings — which is the exact
# defect (a check that reports and still passes) this repo already has filed
# against another script. Do not "simplify" this back into a pipeline.
#
# bash 3.2 compatible on purpose: authored on macOS, runs on Linux CI.
set -uo pipefail
cd "${1:-.}" || exit 2
DECL_DIR="gateway/composition/input"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
fail=0

{ grep -rn --include='*.ts' -oE '\benable_[a-z0-9_]+\?: *boolean' "$DECL_DIR" 2>/dev/null || true; } \
  | sed -E 's/\?: *boolean$//' | sort -u > "$tmp"

if [ ! -s "$tmp" ]; then
  echo "composition-wiring-gate: found NO enable_* declarations under $DECL_DIR."
  echo "That means this check is no longer looking where the flags live — treat it"
  echo "as a broken gate, not a clean bill of health."
  exit 2
fi

while IFS= read -r d; do
  file="${d%%:*}"; rest="${d#*:}"; line="${rest%%:*}"; name="${rest#*:}"
  # A SETTER is `name:` in an object literal, in a non-test .ts file, and not the
  # declaration (`name?:`). A READ (`cfg.name === true`) is the GATE, not the
  # wiring, and must never count — that distinction is the entire mechanism.
  # EVERY grep here is `|| true`. A grep that matches nothing exits 1, and with
  # `pipefail` set that fails the whole pipeline — which under `set -e` aborts
  # the script. CI invokes this as `bash -e script.sh`, so WITHOUT these the one
  # case the gate exists for (a flag with NO setter) exited 1 having printed
  # NOTHING: a red build with no diagnostic, which is how a check gets disabled.
  # Verified under `bash -e` in both directions before this line was written.
  setters=$({ grep -rn --include='*.ts' -E "(^|[^.a-zA-Z0-9_])${name}: *(true|false|[a-zA-Z])" . 2>/dev/null || true; } \
    | { grep -v '/node_modules/' || true; } \
    | { grep -vE '(__tests__|\.test\.ts|/vendor/)' || true; } \
    | { grep -vE "${name}\?:" || true; } \
    | { grep -v "^\./${DECL_DIR}/" || true; } | wc -l | tr -d ' ')
  if [ "$setters" = "0" ]; then
    echo "DEAD  $name   declared ${file}:${line} — no non-test caller sets it"
    fail=1
  else
    echo "ok    $name   ($setters setter(s))"
  fi
done < "$tmp"

if [ "$fail" != "0" ]; then
  echo ""
  echo "A declared switch that no real composer sets is a feature that cannot run."
  echo "Fix by wiring it in the production composer, or by DELETING the flag and"
  echo "its dead path. A permanently-unset flag is what hid six of these."
fi
exit $fail
