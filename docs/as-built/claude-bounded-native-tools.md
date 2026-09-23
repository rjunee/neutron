## 2026-09-23 — Give native bounded Claude workers a code-only tool surface

The same-provider dispatcher selected Claude's `general-purpose` agent, which
inherits the parent conversation's MCP tools. Every bounded planner, builder and
reviewer therefore received the owner's unrelated tool schemas. The native
placement required by `docs/plans/harness-orchestrator-pivot-2026-09-11.md:94-111`
remains unchanged.

`runtime/workers/claude-bounded-profile.ts` defines a host-owned native agent with
Read, Grep, Glob, Bash, Edit and Write. The persistent REPL registers that agent
through `--agents`, and the bounded dispatcher selects it explicitly. The parent
keeps its existing built-in and MCP permissions. The child retains code search,
execution, editing and the host's result-file transport. This tool surface does
not claim a new filesystem or network sandbox; the existing request grants and
result validation still apply.

The exact profile fingerprint travels with the spawn's persisted reuse
properties. Adoption restores that observation rather than asserting the current
definition was supplied to an older process. Bounded dispatch refuses a missing
or stale profile before terminal submission. Normal reuse refreshes an idle
legacy session once when the current gateway has owned its entire lifetime;
active turns and native-child leases defer that refresh. Adopted parents remain
deferred even with no reconstructed local leases: those empty counters cannot
establish that children from the previous gateway have stopped. An adopted
legacy profile needs an explicit lifecycle migration after surviving work has
been reconciled. This change deliberately does not infer safe replacement from
a quiet composer or a completed chat turn.

The focused tests cover parent permission preservation, profile provisioning,
dispatch selection, adopted profile provenance, fail-closed capability checks,
and busy-versus-idle refresh. Semantic mutations admit a legacy profile, reject a
current profile, retain an idle stale process, and replace a busy process; each
fails its behavioral regression. This slice supports issue #1196. It does not
claim measured live token savings or completion of the efficiency item; those
require the deployed run evidence specified by that item.
