#!/usr/bin/env bash
# Runner provisioning only. Local test entrypoints never change host policy.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_ENVIRONMENT:-}" != github-hosted || "${RUNNER_OS:-}" != Linux ]]; then
  echo 'Process-test CI setup refused: requires a GitHub-hosted Linux runner' >&2
  exit 3
fi

if ! command -v bwrap >/dev/null 2>&1 || ! command -v apparmor_parser >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install --yes bubblewrap apparmor
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Ubuntu Noble restricts user namespaces even when bubblewrap is installed.
# Load only this executable's admission profile into this ephemeral runner;
# leave global AppArmor/sysctl policy intact and do not persist a host config.
sudo apparmor_parser --replace --skip-cache "$script_dir/process-test-bwrap.apparmor"

# Provisioning is not proof. The existing launcher authenticates fresh PID/mount
# namespaces and private proc, as the invoking user, before fixtures may load.
python3 -B "$script_dir/../../trident/process-test-isolation.py" -- python3 -B -c 'pass'
