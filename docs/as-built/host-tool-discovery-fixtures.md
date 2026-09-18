## 2026-09-18 — Host-tool discovery fixtures are hermetic

### What changed

The Codex and GBrain installer tests now construct a PATH containing only the
real support utilities the installer seam needs. Before invoking `install.sh`,
each fixture uses the same shell `command -v` lookup as the installer to prove
that its target is absent; the already-installed fixture adds its executable and
proves the complementary present result. A machine-wide executable can no longer
short-circuit a test that intends to exercise installation or failure.

The GBrain resolver accepts an optional absolute-probe candidate list. Its
production default remains `gbrainProbePaths(env)`. Negative tests pass isolated
missing or non-executable candidates, while the existing default-path controls
still prove that a PATH fixture and the generated production probe list resolve.

No installer behavior, fallback path, or product feature flag changed.

### Why

The fixtures previously put `/usr/bin` on the Codex PATH and inherited the host
PATH for GBrain. The resolver's negative cases also exercised production's fixed
system probes. A host with Codex or GBrain installed therefore supplied the very
binary those cases claimed was absent, turning deterministic branch tests into
host-dependent failures.

### Verification

- Baseline on the affected host: 17 pass, 11 fail across the three targeted
  files (2 resolver, 4 Codex-installer, and 5 GBrain-installer failures).
- `bun test gbrain-memory/__tests__/resolve-gbrain-command.test.ts tests/integration/install-codex.test.ts tests/integration/install-gbrain.test.ts`
  — 28 pass, 0 fail, 87 assertions.
- `bunx tsc -p tsconfig.json --noEmit` — pass.
- `bunx tsc -p trident/tsconfig.json --noEmit` — pass.
- `bunx tsc -p gbrain-memory/tsconfig.json --noEmit` — pass.
- `bash scripts/ci/lint.sh` — pass, zero findings in every reported gate.

### Deliberately not done

The final gate environment is not masked, `install.sh` is unchanged, and no
assertion was weakened. The fixtures isolate only executable discovery while
continuing to run the real installer seam and real resolver behavior.
