---
title: Keep generated suggestions out of machine-dispatched Claude composers
group: platform
status: open
priority: P1
cutover: false
needs_spec: false
---

# Claude project prompt suggestions

The project conversation remains the orchestrator and same-provider bounded work
remains a native Agent invocation inside it. No separate reviewer dispatcher,
headless fallback, warm spare, or input-clearing operation is introduced.

Newly created owner project and General Claude REPLs must receive
`CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false`. This is a fixed construction policy,
not an operator feature flag. Claude documents this environment variable as
taking precedence over `promptSuggestionEnabled` in settings:
[official interactive-mode reference](https://code.claude.com/docs/en/interactive-mode#turn-prompt-suggestions-off).
The accepted tradeoff is that direct terminal users of these same sessions no
longer receive generated prompt suggestions. Unrelated helper substrates retain
their existing configuration.

The rendered composer guard remains conservative. A visible suggestion in an
existing session, a genuine draft, unreadable screen, or busy/menu chrome must
still refuse before text or Enter. Dim styling is not input-buffer authority.
Disabling suggestions prevents one source of future false refusal; it is not
proof that a particular historical refusal was caused by suggestions and does
not override native child leases, dispatch ownership, or provider busy state.

An adopted live session is unchanged. Deployment alone cannot update that
process's environment; the policy takes effect only after independently safe
session recreation. This change does not authorize retirement or restart.

## Acceptance

- [ ] Constructor options carry the fixed value for both project and General;
      unrelated substrate options remain unchanged and construction is lazy.
      Verify: `open/__tests__/open-wiring-substrates.test.ts`.
- [ ] Empty ready composers remain usable; genuine drafts and dim suggestions
      still refuse, including a real draft followed by a dim suffix.
      Verify: `runtime/workers/claude-composer.test.ts`.
- [ ] Consuming build dispatch preserves adopted visible suggestions, drafts,
      busy and unreadable screens without any text/Enter RPC; an empty ready
      composer completes via the same native path.
      Verify: `open/__tests__/project-build-e2e.test.ts`.
