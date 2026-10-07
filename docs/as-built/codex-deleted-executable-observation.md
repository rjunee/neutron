## 2026-10-07 — Retain stable non-Codex executable evidence after unlink

The account observer rejected every executable link ending in Linux's
` (deleted)` marker before classifying the process. A real synthetic executable
unlinked while running retained a readable regular inode with the same device
and inode, plus readable argv, but the classifier returned `incomplete`.
That blanket refusal could block account admission on an unrelated process.

`runtime/adapters/codex-cli/codex_account_observation.py:80` now accepts that
regular executable evidence. Recognition at `:182` removes only the terminal
marker; the raw link target, device and inode remain in both sides of the existing
stability checks. Deleted Codex executables and recognized wrappers still
refuse, including a Codex executable with misleading non-Codex argv. A literal
filename with that suffix receives the same conservative native refusal.
Nonregular or unreadable evidence still refuses. Non-Codex exclusion still
requires stable credentials, PID/start, executable and argv across the complete
observation, and does not read that process's environment.

The existing provider-resolution specification now states that distinction.
No process-name exception, ignored read error, copied credential, native process
control, or alternative classifier was introduced. SYSTEM-OVERVIEW.md changes:
none; this repairs the existing classifier without changing its interface.

Verification: all 19 tests in `account-writer-test.py` passed. The new Linux
fixtures run copied readers, unlink their executable files, and finish only
those synthetic children by closing their input. Same-account admission stays
busy and a distinct account admits alongside the deleted non-Codex process.
Deleted native/wrapper, literal-suffix, unreadable/nonregular and changed raw
target/device/inode/argv controls refuse. All 16 semantic mutations in
`account-observation-mutation-test.py` were rejected with their valid controls
passing, including blanket deleted-file refusal, removed native refusal and
removed suffix recognition.

The consuming `account-writer-lock.test.ts` run initially failed before reaching
classification because a host observer registration remained visible in its
private test namespace. The companion test-authority masking repair owns that
boundary; production pin validation stays intact. The integrating admission
gate also includes `open/__tests__/project-build-e2e.test.ts`. Live observer
installation and actual build acceptance remain separate deployment evidence.
