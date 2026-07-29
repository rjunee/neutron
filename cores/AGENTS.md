# AGENTS.md — cores

This module hosts the bundled-free Cores (Email, Calendar, Research, Notes, Tasks, Coordinator) and any user-installed Cores. Each Core is an npm-shape package with a `"neutron"` section in its `package.json` validated by the single Zod schema in `cores/sdk/manifest.ts` (`@neutronai/cores-sdk`). Bundled-free Cores ship in P3; the empty skeleton is P0.

It must NOT contain runtime dispatcher logic (lives in `runtime/`), the manifest-validator type definitions (live in `cores/sdk/`), or per-Core data (default is named tables in the project DB; `<core>.db` separate file only when isolated lifecycle is needed — P3 detail).

Cross-refs: `docs/engineering-plan.md § B.P3`, `docs/engineering-plan.md § E` (linked-source pattern), `docs/plans/P0-system-user-data-separation.md § 1.6`.
