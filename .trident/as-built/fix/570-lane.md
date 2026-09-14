## Issue 570 — bound the switch paint mark in frames

### Built

The switch timer now waits for two browser presentation opportunities after its required marks arrive, using an injectable frame scheduler at `landing/chat-react/switch-timing.ts:227-230` and the frame countdown at `landing/chat-react/switch-timing.ts:387-404`. This replaces the former 250 ms paint-settlement race. The complete-tree search was `rg -n "paintSettleMs|PAINT_SETTLE_MS|deadlineMs" landing/chat-react --glob '*.{ts,tsx}'`: it found the positive-control deadline symbols at `landing/chat-react/switch-timing.ts:226,267,290,297` and no old paint-millisecond symbol.

Paint knowledge now uses the existing `SwitchRecord` outcome vocabulary. Its `paint` field distinguishes `painted`, `not_painted`, and `unknown` at `landing/chat-react/switch-timing.ts:210-212`. A real frame mark selects `painted` at `landing/chat-react/switch-timing.ts:322-327`; hidden visibility selects `not_painted` at `landing/chat-react/switch-timing.ts:390-394`; missing visibility or frame APIs retain the conservative `unknown` state and wait for the existing deadline at `landing/chat-react/switch-timing.ts:274,396`. The persisted report schema advances to 5 and carries the outcome at `landing/chat-react/switch-timing.ts:504-532`, so the new value does not fall through an unrelated default.

The invariant is continuously maintained by `SwitchTimer.mark`: once required marks arrive it always enters `settlePaintInFrames` unless paint was already observed at `landing/chat-react/switch-timing.ts:327-333`. Browser `requestAnimationFrame` drives the visible path at `landing/chat-react/switch-timing.ts:291,397-404`; document visibility drives the hidden path at `landing/chat-react/switch-timing.ts:292-295,390-394`; neither depends on the missing paint callback still working. The existing 30-second deadline owns the unknown fallback at `landing/chat-react/switch-timing.ts:245,290,297`.

### Decisions

Two frames are used because the controller stamps paint from a trailing task after its animation callback at `landing/chat-react/controller.ts:1671-1687`; the second presentation opportunity permits that task to run before settlement. Hidden documents settle on the next task so already-queued transcript refresh work can still add its diagnostic marks, as covered at `landing/chat-react/__tests__/switch-transcript-cache.test.ts:974-1007`. Environments that cannot report visibility or schedule a frame remain `unknown`; they are not treated as proof that no paint occurred.

### Verification

The focused command `bun test landing/chat-react/__tests__/switch-timing.test.ts landing/chat-react/__tests__/switch-render-cost.test.tsx landing/chat-react/__tests__/switch-transcript-cache.test.ts` passed 53 tests and 211 assertions. The frame-count test advances its logical clock by 60,000 ms without settling, then drives exactly two callbacks at `landing/chat-react/__tests__/switch-timing.test.ts:148-170`. The state test independently covers known-hidden and unknown outcomes at `landing/chat-react/__tests__/switch-timing.test.ts:173-200`.

| Guard | Compiling mutation | Red evidence | Restored evidence |
|---|---|---|---|
| Two-frame boundary (`switch-timing.ts:401`) | `remaining === 0` → `remaining === 1` | `missing paint settles after two browser frames` failed after callback one: expected zero records, received one | Focused suite green |
| Hidden classification (`switch-timing.ts:391`) | `visibility === 'hidden'` → `visibility === 'visible'` | `hidden and unknown paint states do not collapse into one permissive outcome` failed: expected the hidden record, received none | Focused suite green |
| Unknown default (`switch-timing.ts:274`) | `'unknown'` → `'not_painted'` | The same state test failed: expected `unknown`, received `not_painted` | Focused suite green |

`bash scripts/ci/lint.sh` passed, including the armed wall-clock gate invoked at `scripts/ci/lint.sh:103-110`. `bunx tsc --noEmit` reached three pre-existing errors outside this lane at `gateway/transcription/__tests__/whisper-install.test.ts:186`, `logger/__tests__/fire-and-forget.test.ts:301`, and `onboarding/history-import/__tests__/zip-writer.ts:10`; none is in the four-file change enumerated by `git diff --stat`.

### Deliberately not built

The general 30-second incomplete-switch deadline remains unchanged because it bounds failed switches rather than racing a paint mark (`landing/chat-react/switch-timing.ts:235-245`). The controller's paint-stamping mechanism also remains unchanged because it already uses browser-frame ordering (`landing/chat-react/controller.ts:1671-1687`). No feature flag or compatibility path was added.
