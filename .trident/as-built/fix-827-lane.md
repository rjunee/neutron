## Issue #827 — legible gateway REPL pane labels

### What changed

`PtySpawnOpts` now accepts an optional human-readable label (`runtime/adapters/claude-code/persistent/pty-host.ts:345-350`). The persistent spawn forwards its caller-composed value (`runtime/adapters/claude-code/persistent/spawn.ts:416-420`), and the herdr layout uses it while retaining `neutron-repl` for an omitted value (`runtime/adapters/claude-code/persistent/herdr-host.ts:945-954`).

The adapter and gateway construction bags preserve the label at `runtime/adapters/claude-code/index.ts:415-419` and `gateway/wiring/build-llm-call-substrate.ts:834-838`. Open construction sites compose labels from their known role and project/card context: chat at `open/wiring/substrates.ts:266-275`, compose at `open/wiring/substrates.ts:354-365`, dispatched research/build work at `open/wiring/substrates.ts:499-512`, and the warm build launcher at `open/wiring/substrates.ts:552-566`. History import uses the same explicit role-based scheme at `gateway/wiring/build-import-substrate.ts:395-399` and `open/composer.ts:1384-1393`.

### Decisions

The label is a separate option rather than a transformation of `substrate_instance_id`. That keeps process identity and display text independent and prevents identity-bearing raw instance IDs from reaching herdr labels. The complete set of new production assignments was enumerated with `rg -n 'repl_pane_label' runtime gateway open --glob '*.ts'`; the same search, extended with `.*(substrate_instance_id|owner_handle|cwd)`, found the known assignments but no assignment deriving a label from those fields.

The established default vocabulary is `HERDR_REPL_PANE_LABEL = 'neutron-repl'` at `runtime/adapters/claude-code/persistent/herdr-host.ts:94`; an omitted new option joins that existing fallback at `runtime/adapters/claude-code/persistent/herdr-host.ts:953`. This change adds no new error, verdict, state, or refusal.

### Verification and mutation table

| Guard | Compiling mutation | RED | Restored GREEN |
|---|---|---|---|
| `opts.label ?? HERDR_REPL_PANE_LABEL` at `runtime/adapters/claude-code/persistent/herdr-host.ts:953` | Replace it with `HERDR_REPL_PANE_LABEL` | `gives concurrently spawned REPL kinds different labels and keeps the fallback` failed because both explicit labels became the fallback | Focused file: 45 pass, 0 fail |

The test spawns chat, build, and omitted-label panes together, asserts the first two are distinct, and asserts the third receives the fallback (`runtime/adapters/claude-code/persistent/__tests__/herdr-snapshot-ring.test.ts:843-868`). The focused test and repository lint are green. The typecheck matrix checked 51 configurations; the changed `runtime` and `open` configurations passed, while the matrix remained red on pre-existing unrelated type errors in app, gateway test support, logger test support, onboarding test support, and the root configuration.

### Deliberately not changed

No tool or permission plumbing in `runtime/adapters/claude-code/persistent/spawn.ts` changed. No feature flag, alternate spawn path, new outcome, or spec decision was introduced. The retained Bun backend accepts the expanded option bag but does not consume a herdr-specific pane label.
