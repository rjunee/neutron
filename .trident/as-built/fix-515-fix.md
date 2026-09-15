## Issue #515 — stop a build process reading the owner's encryption keyfile

### What changed

The workflow now hands the existing owner data-directory coordinate to the Codex wrapper as non-secret launch metadata (`trident/inner-workflow.mjs:1598-1602`, `trident/inner-workflow.mjs:1623-1624`). The wrapper converts that coordinate to the fixed keyfile path before entering the existing lane-process owner (`trident/codex-build.sh:432-439`).

The lane owner now constructs a bubblewrap mount namespace before launching build code. The host filesystem is read-only by default, the current worktree, temporary directory, and configured Codex credential directory retain the access the build needs, and the final mount masks only the owner keyfile (`trident/lane-processes.py:219-238`). A missing or non-file key path and a missing bubblewrap executable refuse before the child is launched (`trident/lane-processes.py:223-228`, `trident/lane-processes.py:241-250`).

The source-of-truth item is marked done and records the delivered boundary (`docs/spec-items/a-build-process-must-not-decrypt-secrets-it-was-not-given.md:1-7`, `docs/spec-items/a-build-process-must-not-decrypt-secrets-it-was-not-given.md:76-94`).

### Decisions

The boundary belongs in `lane-processes.py`, not in model instructions: every Codex build already enters that independent owner before build code runs (`trident/codex-build.sh:432-439`), and the kernel maintains the mask after launch without relying on the build to cooperate (`trident/lane-processes.py:230-250`). Bubblewrap was selected because the repository already treats Linux process ownership as a hard prerequisite at this boundary (`trident/lane-processes.py:267-278`), and a mount namespace denies the file even though the child retains the owner's uid.

The new setup failure joins the established wrapper exit vocabulary as a deferral. Pre-launch evidence failures return 3 directly (`trident/lane-processes.py:245-249`); a namespace-exec failure is a non-zero build exit, which the existing wrapper contract classifies as deferred (`trident/codex-build.sh:404-416`). The diagnostic is constant and contains neither the key path nor file contents (`trident/lane-processes.py:247-249`).

The complete new-coordinate wiring set was enumerated with `rg -n "NEUTRON_BUILD_OWNER_DATA_DIR|NEUTRON_CODEX_BUILD_BRIEF_FILE" trident --glob '*.{mjs,sh,ts,py}'`. Positive controls were the established brief-variable uses at `trident/codex-build.sh:919` and `trident/codex-build.test.ts:578`; the new coordinate occurs at the producer, wrapper consumer, and focused assertion (`trident/inner-workflow.mjs:1601`, `trident/codex-build.sh:436-437`, `trident/inner-workflow.test.ts:415-418`).

### Verification and mutation table

| Guard | Compiling mutation | RED | Restored GREEN |
|---|---|---|---|
| Final keyfile mask at `trident/lane-processes.py:236-237` | Remove only `--bind /dev/null <keyfile>` while retaining the valid namespace | `test_build_can_use_handed_secret_but_cannot_read_owner_keyfile` observed `allowed-value:readable` | The same test observed `allowed-value:denied` and passed |

The real-process regression passes a handed value through the environment and attempts to read the real keyfile path in the same child (`trident/lane-processes-test.py:365-379`). A separate regression proves missing isolation evidence returns 3 without calling `Popen` (`trident/lane-processes-test.py:381-385`). The workflow composition assertion proves the coordinate reaches the wrapper invocation (`trident/inner-workflow.test.ts:415-418`).

Focused validation passed 269 tests across `trident/lane-processes.test.ts`, `trident/inner-workflow.test.ts`, and `trident/codex-build.test.ts`; the final two-file run passed 154 tests. Repository lint passed. The typecheck matrix checked all 51 configurations: 50 passed, including `trident/tsconfig.json`; `app/tsconfig.json` failed before reaching changed code because its implicit `@types` definition directory was unavailable.

### Deliberately not changed

This change does not move or re-encrypt stored secrets, expose a plaintext credential, change the host-side authenticated GitHub runner, add an alternate build path, or isolate the review-only Codex process. The shipped scope is the build process named by the acceptance criteria; the existing host publisher continues resolving its credential outside that process.
