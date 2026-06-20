# Onboarding freeform-intent routing — canonical spec

**Status:** locked 2026-06-03 (Forge, `forge/onboarding-freeform-intent-classifier-2026-06-03`)
**Owner doc:** this file is the source of truth for "how freeform replies are
classified and routed during the onboarding interview." Update it spec-first
before changing the routing matrix.

---

## 0. Why this doc exists — the 2026-06-03 incident + the brief's false premise

**Incident (Sam, M3 testing):** at `import_upload_pending` with
`ai_substrate_used=chatgpt`, Sam typed *"actually can i upload claude
instead"*. The bot replied "Analyzing your conversations now…" and stuck on
`import_running` with an empty jobs table.

**The sprint brief's stated premise was wrong.** The brief said *"NO LLM
classifier on freeform; the user's intent was never classified"* and asked for
a brand-new parallel Opus classifier. In fact a freeform classifier already
ships and is live:

- `onboarding/interview/llm-router.ts` (`buildLlmRouter`) classifies **every**
  freeform turn into `advance` / `answer` / `amend`.
- It is wired into the engine at `engine.ts` (the freeform fall-through in
  `advance` → `dispatchRouterDecision`).
- `NEUTRON_ONBOARDING_CONVERSATIONAL=1` is set on the prod
  the per-instance systemd template and was confirmed in
  a live process — so the router **does** fire in production.
- The `import_upload_pending` knowledge pack even carried an example tagged
  `"THE BRIEF INCIDENT"`.

Building a second, parallel classifier would have meant **two competing LLM
classification systems on the same freeform input** (double latency/cost,
conflicting decisions) — a direct "one source of truth per concern" violation.
So this sprint does **not** add a parallel classifier. It fixes the existing
router's handling of the one intent it could not express: a **source switch**.

### Actual root cause (three mechanical bugs, not a missing classifier)

1. **Wrong field.** The pack's amend example wrote `ai_substrate_available`,
   but the dynamic upload body (`buildImportUploadPendingPromptSpec`,
   `phase-prompts.ts`) reads `ai_substrate_used`. Different field → the
   instructions never changed.
2. **No re-render.** The engine's `amend` branch called `reEmitKeyboard`, which
   re-sends the **already-persisted** prompt (the old source's body). It never
   re-resolved the dynamic spec, so even a correct amend left the user staring
   at ChatGPT instructions.
3. **No switch example.** The pack had no example for a source-*switch*
   (vs the "give me Claude's instructions too" *question*). The fast model
   therefore classified *"actually can i upload claude instead"* as `advance`,
   which (with no `choice_value`) became `__freeform__` →
   `next_phase_on_default: import_running`. The incident.

### Model decision — kept Haiku→Sonnet, declined the brief's Opus mandate (this path only)

The router runs **synchronously in the live chat turn** with hard timeouts
(`HAIKU_TIMEOUT_MS_DEFAULT = 3000`, `SONNET_TIMEOUT_MS_DEFAULT = 5000` in
`llm-router.ts`). **On timeout the router falls back to `advance`** — exactly
the failure that produced the incident. Opus 4.7 routinely exceeds 5s, so
forcing Opus on this path would *reintroduce* the incident via timeout. The bug
is mechanical (fields 1–3 above), not model-bound — a bigger model cannot fix
(1) or (2). The fix therefore keeps the fast-model path and fixes the
mechanics + the pack. To run Opus here one would also have to raise the
timeouts and accept multi-second chat latency; that is a separate product call.

---

## 1. The routing primitive (unchanged)

Every freeform turn on a `allow_freeform` phase that has a `PhaseKnowledgePack`
and a wired router is classified by `llm-router.ts` into one of three actions
(`RouterDecision.action`):

| action    | meaning                                                        | engine effect (`dispatchRouterDecision`)                              |
|-----------|----------------------------------------------------------------|-----------------------------------------------------------------------|
| `advance` | the reply answers the phase question; move on                  | feed `choice_value`/`freeform_text` into `consumeChoice`              |
| `answer`  | a tangential question; reply in-context, stay on phase         | `sendAgentText(response)` + `reEmitKeyboard`; no state change          |
| `amend`   | a fact/correction that updates state but isn't a direct answer | whitelist-merge `state_delta`; `sendAgentText(response)`; stay on phase |

Below `clarify_threshold` (0.7) the router escalates Haiku→Sonnet, then
degrades to a synthesised ask-clarify `answer` ("did you mean A or B?"). This
is the "unclear" path — no new code needed.

## 2. The amend source-switch extension (new in this sprint)

A source switch is expressed as an **`amend`** whose `state_delta` carries
`ai_substrate_used`. Two engine changes make it work end-to-end:

- `ROUTER_AMEND_ALLOWED_KEYS` now includes `ai_substrate_used`, **value-validated**
  against `ROUTER_AMEND_SUBSTRATE_VALUES` = `{chatgpt, claude, both}` at the
  `dispatchRouterDecision` call site (a hallucinated source is rejected, not
  written).
- When an `amend` on `import_upload_pending` changes `ai_substrate_used` to a
  *different* valid source, the engine **invalidates the cached resolved spec**
  and calls `emitPhasePrompt('import_upload_pending')`, which re-resolves the
  dynamic body for the new source and emits a fresh prompt (new
  `active_prompt_id`). The optional `decision.response` is sent first as the
  acknowledgement ("Got it, switching to Claude…").

## 3. Per-phase intent matrix

Intents are mapped onto the `advance`/`answer`/`amend` vocabulary. The
knowledge pack's `expected_tangents` / `advance_examples` are the few-shot
anchors that make the fast model land the right action.

### `ai_substrate_offered`
| user intent                          | action    | routing |
|--------------------------------------|-----------|---------|
| picks chatgpt / claude / both        | `advance` | `choice_value` → `consumeAiSubstrateOfferedChoice` → `import_upload_pending` |
| neither / skip                       | `advance` | `choice_value: neither` → `work_interview_gap_fill` |
| question ("what's the difference?")  | `answer`  | FAQ reply, re-emit, stay |
| unclear                              | `answer`  | synthesised ask-clarify |

(No source-switch here — the user has not chosen a source yet.)

### `import_upload_pending`
| user intent                                   | action    | routing |
|-----------------------------------------------|-----------|---------|
| skip / "I don't want to do this"              | `advance` | `choice_value: skip` → `work_interview_gap_fill` |
| **switch source** ("upload claude instead")   | `amend`   | `state_delta {ai_substrate_used}` → **re-render dynamic body for new source**, stay on phase (only `chatgpt` / `claude` accepted) |
| question ("give me claude's steps", "format?")| `answer`  | FAQ reply, re-emit, stay |
| uploading now / typed nothing actionable      | `answer`  | re-emit; the actual upload arrives via the upload event, not freeform |
| unclear                                       | `answer`  | synthesised ask-clarify |

### `import_analysis_presented`
| user intent                          | action    | routing |
|--------------------------------------|-----------|---------|
| affirm ("looks good", "yep")         | `advance` | standard advance via `consumeImportAnalysisPresentedChoice` |
| add more context                     | `amend`   | `state_delta {auxiliary_facts|primary_projects|non_work_interests}`, stay |
| question                             | `answer`  | reply, re-emit, stay |
| unclear                              | `answer`  | synthesised ask-clarify |

## 4. Out of scope (per brief)

- LLM classification on non-onboarding surfaces (project topics, etc.).
- Changing the export-instructions copy.
- Multi-import-source *combination* logic beyond the existing `both` branch.
- The historical-import / Pass-1 / Pass-2 substrate.
