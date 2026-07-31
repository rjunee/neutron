#!/usr/bin/env bash
#
# scripts/install-git-hooks.sh — point this clone at the versioned hooks in
# .githooks/ (currently: a pre-push leak gate over commit messages).
#
#   bash scripts/install-git-hooks.sh              # install
#   bash scripts/install-git-hooks.sh --uninstall  # revert to the default hooks
#
# Idempotent. Sets `core.hooksPath` rather than copying files into .git/hooks, so
# a hook improvement reaches everyone on the next pull instead of on the next
# time somebody remembers to re-run this.
#
# WHO THIS IS FOR. The pre-push hook checks commit messages against the OWNER PII
# denylist — a list of the maintainer's proper nouns and private paths. Outside
# contributors have no such list and nothing to check, so this script refuses to
# install without one rather than arming a hook that would block every push with
# a failure the author cannot fix. That refusal is the point: on 2026-07-29 the
# CI leak gate was found to have "run" ~3,700 times with its denylist absent,
# reporting success each time. A control and its pattern source have to be
# installed together or neither is real.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DENYLIST_PATH="${LEAK_GATE_PII_DENYLIST_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/neutron/leak-gate-pii-denylist}"

if [ "${1:-}" = "--uninstall" ]; then
  git -C "$ROOT" config --unset core.hooksPath 2>/dev/null
  echo "hooks: uninstalled — core.hooksPath unset (git is back to .git/hooks)"
  exit 0
fi

if [ ! -d "$ROOT/.githooks" ]; then
  echo "install-git-hooks: no .githooks/ directory at $ROOT" >&2
  exit 1
fi

if [ ! -s "$DENYLIST_PATH" ]; then
  cat >&2 <<EOF
install-git-hooks: NOT INSTALLED — no PII denylist found.

Looked for a non-empty file at:
  $DENYLIST_PATH

The pre-push hook checks the commit messages you are about to publish against
that list, and it fails CLOSED: with no list, every push would be blocked. So
create the list first, then re-run this script.

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
do not need this hook. Skip it — CI runs the same gate on your PR.
EOF
  exit 1
fi

chmod 700 "$(dirname "$DENYLIST_PATH")" 2>/dev/null
chmod 600 "$DENYLIST_PATH" 2>/dev/null

chmod +x "$ROOT"/.githooks/* 2>/dev/null
git -C "$ROOT" config core.hooksPath .githooks

echo "hooks: installed — core.hooksPath = .githooks"
echo "       pre-push  → scripts/ci/leak-gate.sh --messages-only"
echo "       denylist  → $DENYLIST_PATH"
echo
echo "Note: a PR title/body never passes through git, so no hook can see it."
echo "Check one before publishing with:"
echo "  LEAK_GATE_PR_BODY=\"\$(cat pr-body.md)\" bash scripts/ci/leak-gate.sh --messages-only"
