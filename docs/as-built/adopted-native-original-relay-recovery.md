## 2026-10-04 — Recover original native relay authority during parent adoption

The adopted-parent launch producer measured the surviving executable and argv
but omitted the relay capability captured by cold launches. A recovered project
parent therefore lacked the signed physical-parent authority required for native
continuation. This closes that source gap under
`docs/spec-items/claude-same-agent-continuation.md:87` without weakening the
current native profile or manufacturing authority from registry/transcript data.

`runtime/adapters/claude-code/persistent/adopted-native-parent-launch.ts:20`
reads the survivor's original scope header from its process environment, requiring
the currently pinned Unix socket and fixed port-zero base URL. Duplicate, absent,
unreadable, or foreign route evidence refuses preparation. The producer calls the
existing protected-host signed registration protocol for that same token and
PID/start/boot/session (`:80`), then rechecks process, executable, argv, protected
pin and original scope before publication (`:73`). It never generates or replaces
the survivor's original scope token. Host registration may create or recreate its
entry; the returned signature attests the current physical binding, not a
historical registration. That distinction preserves the original-parent/token
requirement in `docs/spec-items/claude-same-agent-continuation.md:87–93`.
Unregistered self-hosted adoption remains unchanged; a provisioned survivor with
missing original authority can still be adopted for ordinary work but receives no
continuation launch evidence. Existing boot-adoption publication ordering is
unchanged.

Verification: 16 focused producer/publication tests passed using synthetic Unix
hosts with real signatures and physical test-process identities; root and Trident
TypeScript checks passed. The publication pair in
`runtime/adapters/claude-code/persistent/__tests__/adopted-native-launch-publication.test.ts:110`
proves signed original-scope recovery after adoption and ordinary adoption without
authority for a scopeless survivor. Producer controls cover foreign/ambiguous
routes, forged signatures, wrong process birth, changed route/pin, and existing
argv/image ownership checks. Opposite semantic mutants (admit a missing original
scope; refuse every provisioned survivor) each failed their corresponding test
and were restored.

The shared `open/__tests__/project-build-e2e.test.ts` fixture now passes its
original signed scope through the adopted producer's process-environment seam,
with the actual test PID and real signed Unix transport. It never injects a relay
into adopted launch evidence. The successful sibling re-registers the same
token, plans, dispatches native work, continues the same child with `SendMessage`,
and reaches merge. The missing-scope sibling records no launch evidence and
refuses before child admission or input. Existing unregistered adoption controls
explicitly select no relay pin. Both new cases failed against the old producer;
20 selected consuming cases then passed with the producer repair (114 assertions).
These results are source and fixture evidence, not deployed native acceptance.
