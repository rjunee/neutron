---
title: Native scratch installs reuse Bun cache hardlinks
group: platform
status: open
priority: P0
cutover: true
sections: 1
criteria: 4
contract_items: 0
---

# Native scratch installs reuse Bun cache hardlinks

Work state: GitHub issue #1327.

Linux native sandbox commands see writable scratch through a bind mount. The
default Bun cache can be outside that mount even when both paths have the same
device number. Hardlink then returns `EXDEV`, and Bun silently copies each
dependency tree. A root package preinstall hook runs after materialization and
can also be bypassed with `--ignore-scripts`.

Prepare a private, UID-owned Bun cache under the native temporary directory
before launching the Open native app-server. Seed an existing cache using
hardlinks only; never fall back to copying or expose a partially seeded cache.
Pass its path through `BUN_INSTALL_CACHE_DIR` in the app-server environment so
ordinary native shell commands and subagents inherit it. Preserve unrelated
environment settings. Refuse untrusted cache paths and failed seeding with an
actionable error before the native child starts.

This mitigates duplication for worktrees on the same writable scratch mount.
It does not implement free-space reservation, workflow ownership, automatic
terminal cleanup, or protection against explicit cache/backend/environment
overrides. Existing warm owners retain their launch environment. Cache removal
must not break already installed hardlinks; later launches may recreate it.

## Acceptance

- [ ] The production native transport supplies the prepared cache to its child;
      real native direct shell execution inherits the value, including an install
      using `--ignore-scripts`. A removed environment assignment fails the check.
- [ ] Seeding preserves file device/inode identity, and independent native
      scratch installs share cached file inodes. Runtime peer resolution and
      valid TypeScript pass; deliberately invalid TypeScript fails. Replacing
      hardlink seeding with copying fails the inode control.
- [ ] A symlink, foreign owner, permissive cache directory, invalid readiness
      record, or unavailable hardlink refuses launch. A valid private cache is
      adopted without reseeding, and concurrent preparation uses one complete
      cache. A reject-everything mutation fails the valid sibling.
- [ ] Renaming or deleting an isolated source cache leaves previously installed
      runtime and compiler dependencies usable. Tests never clean live worktrees.

Verify: focused native cache tests and the consuming native cache smoke in
`runtime/adapters/codex-cli/persistent/`. Record fixture proof, local validation,
remote CI and deployment separately in the implementation as-built record.
