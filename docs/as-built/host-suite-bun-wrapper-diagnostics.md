## 2026-09-24 — Show bounded untrusted failure names from generic host suites

Follow-up to #1261. In a live run, the host's full-suite command was `bun run test`.
The suite log named `scripts/__tests__/discover-test-files.test.ts:53`, but the
generic host finding quoted only the final 6,000 characters, after that failure.
The review panel happened to name the test independently in this run. A fix worker
must not have to depend on that panel observation to find the host's red test.

`suiteFailure` now adds up to 20 Bun-shaped `file: test` lines from the streamed
log to generic diagnostics, with each line capped at 240 characters and explicitly
labelled untrusted. The wrapper stays `generic`; it gets no `hostFailureId` and no
new pre-existing-red exemption. G063 still uses the host's exit receipt, and G065
and G072 keep their existing evidence and unknown-identity behavior. The parser's
64 KiB line bound and 6,000-character tail remain unchanged.

Review found why a post-run package and runner hash cannot safely promote this
wrapper to trusted Bun identity. Installed Bun 1.3.13 executes `pretest` before
`test`, and prepends `node_modules/.bin` to PATH, allowing a local `bash` shim to
run instead of system bash. Tests execute both cases and a normal sibling; the
generic classification then proves the host finding shows a bounded name without
minting identity. A runner can also be restored after execution, so its post-run
bytes are not an execution receipt.

The focused parser and review-gate run passed 16 tests with 132 assertions.
Removing the generic named hint and promoting the wrapper to Bun identity were
each tested as semantic mutations; both made the focused test fail. The
consuming Open E2E file passed 300 tests and hit nine local Unix-socket permission
failures. Those exact nine passed on a permitted rerun (125 assertions). Root
and Trident TypeScript checks and lint passed. The as-built guard, commit-message
leak scan, and diff check passed; CI purity supplies the public-tree leak verdict.
No full suite was run here. A deployed live suite/fix run is still required;
issue #1261 stays open.
