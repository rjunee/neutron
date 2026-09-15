#!/usr/bin/env bash
#
# scripts/install-git-hooks.sh — install the versioned hooks from .githooks/.
#
#   bash scripts/install-git-hooks.sh              # install
#   bash scripts/install-git-hooks.sh --uninstall  # revert to the default hooks
#
# Idempotent. A dedicated directory under the git directory links to the hooks in
# the worktree, so edits to installed hooks arrive on pull without taking over
# user-managed .git/hooks. The installed pre-commit hook also refuses when a new
# executable hook has arrived without a corresponding managed link.
#
# WHO THIS IS FOR. The pre-push hook checks commit messages against the OWNER PII
# denylist — a list of the maintainer's proper nouns and private paths. Outside
# contributors have no such list and nothing to check, so the pre-push hook is
# installed only when a non-empty list is available. The independent pre-commit
# integrity hook is always installed. On 2026-07-29 the CI leak gate was found to
# have "run" ~3,700 times with its denylist absent, reporting success each time;
# the pre-push control and its pattern source still install together or neither
# is real.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DENYLIST_PATH="${LEAK_GATE_PII_DENYLIST_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/neutron/leak-gate-pii-denylist}"
GIT_DIR="$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null)" || {
  echo "install-git-hooks: cannot resolve the git directory for $ROOT" >&2
  exit 1
}
HOOKS_DIR="$GIT_DIR/neutron-hooks"

if [ "${1:-}" = "--uninstall" ]; then
  git -C "$ROOT" config --worktree --unset core.hooksPath 2>/dev/null \
    || git -C "$ROOT" config --unset core.hooksPath 2>/dev/null
  echo "hooks: uninstalled — core.hooksPath unset (git is back to .git/hooks)"
  exit 0
fi

# A repository can have several worktrees. Keep each worktree's absolute managed
# directory in its own config so installing here cannot redirect another
# worktree's hooks back into this checkout.
git -C "$ROOT" config extensions.worktreeConfig true || exit 1

if [ ! -d "$ROOT/.githooks" ]; then
  echo "install-git-hooks: no .githooks/ directory at $ROOT" >&2
  exit 1
fi

rm -rf "$HOOKS_DIR"
mkdir -p "$HOOKS_DIR" || {
  echo "install-git-hooks: cannot create managed hook directory" >&2
  exit 1
}
chmod +x "$ROOT/.githooks/pre-commit" 2>/dev/null
chmod +x "$ROOT/.githooks/pre-push" 2>/dev/null

# The marker lets pre-commit distinguish this managed directory from a
# contributor's own core.hooksPath. The exclusion marker preserves the rule that
# pre-push and its local pattern source are armed together or not at all.
: > "$HOOKS_DIR/.neutron-managed-hooks"
if [ ! -s "$DENYLIST_PATH" ]; then
  : > "$HOOKS_DIR/.pre-push-disabled"
fi

for hook_path in "$ROOT"/.githooks/*; do
  [ -f "$hook_path" ] && [ -x "$hook_path" ] || continue
  hook_name=${hook_path##*/}
  if [ "$hook_name" = "pre-push" ] && [ ! -s "$DENYLIST_PATH" ]; then
    continue
  fi
  ln -s "$hook_path" "$HOOKS_DIR/$hook_name" || exit 1
done

if [ ! -s "$DENYLIST_PATH" ]; then
  git -C "$ROOT" config --worktree core.hooksPath "$HOOKS_DIR"
  cat <<EOF
hooks: PARTIALLY INSTALLED — core.hooksPath set to the managed hook directory
       pre-commit → ACTIVE: refuses a commit whose HEAD does not resolve
       pre-push  → NOT INSTALLED: no PII denylist found

Looked for a non-empty file at:
  $DENYLIST_PATH

The pre-push hook fails closed when it cannot check commit messages against that
list. Create the list and re-run this script to install pre-push as well.

  mkdir -p "\$(dirname "$DENYLIST_PATH")"
  \$EDITOR "$DENYLIST_PATH"     # one entry per line; '#' comments allowed
  chmod 600 "$DENYLIST_PATH"

Entry syntax is documented in scripts/ci/leak-gate.sh (see "compile_denylist").
It is the SAME list as the LEAK_GATE_PII_DENYLIST_B64 repository secret, just not
base64-wrapped — the wrapping is there to survive a CI environment variable, not
for secrecy.

Keep it where it is: OUTSIDE every working tree, so that no \`git add\` in any
repository can ever pick it up. A denylist committed to a public repo would
publish the exact strings it exists to ban.

If you are an outside contributor: you have nothing to put in this file and you
do not need the pre-push hook. CI runs the same gate on your PR.
EOF
  exit 0
fi

chmod 700 "$(dirname "$DENYLIST_PATH")" 2>/dev/null
chmod 600 "$DENYLIST_PATH" 2>/dev/null

git -C "$ROOT" config --worktree core.hooksPath "$HOOKS_DIR"

echo "hooks: FULLY INSTALLED — core.hooksPath set to the managed hook directory"
echo "       pre-commit → ACTIVE: refuses a commit whose HEAD does not resolve"
echo "       pre-push  → ACTIVE: scripts/ci/leak-gate.sh --messages-only"
echo "       denylist  → $DENYLIST_PATH"
echo
echo "Note: a PR title/body never passes through git, so no hook can see it."
echo "Check one before publishing with:"
echo "  LEAK_GATE_PR_BODY=\"\$(cat pr-body.md)\" bash scripts/ci/leak-gate.sh --messages-only"
