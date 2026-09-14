## Issue #630 — split unattended prompting from permission bypass

### What changed

Trident-family Claude Code profiles no longer pass the all-permissions bypass. `PROFILE_EPHEMERAL`, `PROFILE_LEAK_FIXER`, `PROFILE_ARBITER`, and `PROFILE_WARM_FIRE` instead set `skip_permissions: false` and `restricted: true`. The prompt policy is NOT uniform: the three ACTING profiles take `permission_mode: 'acceptEdits'` and the TOOL-LESS arbiter takes `'dontAsk'` (`gateway/wiring/substrate-profiles.ts:276`, `gateway/wiring/substrate-profiles.ts:301`, `gateway/wiring/substrate-profiles.ts:353`, `gateway/wiring/substrate-profiles.ts:406`). The profile factory carries those values into the adapter (`gateway/wiring/build-llm-call-substrate.ts:772-775`, `gateway/wiring/build-llm-call-substrate.ts:845-847`), and the argv builder emits independent `--restricted` and `--permission-mode dontAsk` switches (`runtime/adapters/claude-code/persistent/build-repl-argv.ts:152-160`).

The dangerous flag had disabled two protections observed in the filed real-binary spike: file-tool confinement to cwd/add-dir and explicit `permissions.deny` rules. The implementation was enumerated independently from the option chokepoint: the old boolean selected the sole `--dangerously-skip-permissions` emission (`runtime/adapters/claude-code/persistent/build-repl-argv.ts:152-154`), while the declared built-in tool surface remains a separate CLI gate (`runtime/adapters/claude-code/persistent/build-repl-argv.ts:134-150`). No third in-tree protection was coupled to that boolean.

Restricted mode is the installed CLI's indivisible control for both cwd confinement and continued settings authority; it cannot split those two protections into separate switches. Prompt handling is separately controlled by `--permission-mode dontAsk`, which denies any operation that would otherwise prompt. Combining restricted mode with `--dangerously-skip-permissions` is not a usable residual mode: the installed CLI exits 1 with `bypassPermissions not supported in restricted mode`. The profiles therefore remove bypass rather than setting incompatible flags.

### Complete caller enumeration and remaining reach

Enumeration used `rg -n 'PROFILE_(EPHEMERAL|LEAK_FIXER|ARBITER|WARM_FIRE)|makeEphemeralSubstrate' open trident gateway --glob '*.ts'`, then followed the common factory at `open/wiring/substrates.ts:495-516`. The resulting Trident-family set is: dispatched build agents (`open/composer.ts:1170-1175`), the conflict resolver (`open/composer.ts:6068-6072`), the arbiter (`open/composer.ts:6099-6103`), the leak fixer (`open/composer.ts:6115-6119`), and the warm workflow launcher represented by `PROFILE_WARM_FIRE` (`gateway/wiring/substrate-profiles.ts:367-424`).

For all of them, file tools are confined to the cwd passed into the substrate plus the same cwd supplied as `--add-dir` (`open/wiring/substrates.ts:497-505`, `runtime/adapters/claude-code/persistent/spawn.ts:255-266`). Within that boundary, each agent can still use every tool in its declared `AgentSpec`; restricted mode is a boundary, not read-only mode. The arbiter's declared tool surface remains empty, so its effective filesystem reach remains empty (`gateway/wiring/substrate-profiles.ts:331-342`). GitHub credential reach remains independently profile-controlled (`gateway/wiring/substrate-profiles.ts:280-284`, `gateway/wiring/substrate-profiles.ts:305-308`, `gateway/wiring/substrate-profiles.ts:356-360`, `gateway/wiring/substrate-profiles.ts:410-416`).

Positive control for the absence claim: in `gateway/wiring/substrate-profiles.ts`, `rg -n 'skip_permissions: true|skip_permissions: false'` finds the retained true settings on non-Trident profiles and the new false settings on all four Trident profiles. Thus the same validated pattern both matches known retained bypass sites and establishes that none of the enumerated Trident profiles retains it.

### Decisions and outcome vocabulary

The flag existed to keep unattended interactive REPLs from blocking on approval prompts (`runtime/adapters/claude-code/persistent/build-repl-argv.ts:84-89`). The split preserves that need through automatic prompt denial without granting the attempted operation. A denial joins Claude Code's existing permission outcome vocabulary; Neutron receives the ordinary tool-denied result, so there is no new Neutron error, verdict, state, switch arm, or default classification.

The product decision is recorded at the top of the immutable Decisions Log (`SPEC.md:288-294`), and the superseded arbiter confinement sentence is narrowed in place (`SPEC.md:353`). The invariant is continuously maintained by exact profile-object tests for every named profile and argv assertions at the subprocess boundary (`gateway/wiring/__tests__/substrate-profiles.test.ts:141-210`, `runtime/adapters/claude-code/persistent/__tests__/build-repl-argv.test.ts:155-165`). It does not depend on a defecting agent cooperating: Claude Code enforces the command-line controls before tool execution.

### Mutation table

| Guard | Mutation (printed landing line) | RED | Restored GREEN |
|---|---|---|---|
| cwd/settings enforcement profile | `PROFILE_EPHEMERAL.restricted: true` → `false` at `gateway/wiring/substrate-profiles.ts:278` | profile suite: 2 failures | profile suite: green |
| unattended prompt denial profile | `permission_mode: 'dontAsk'` → `'bypassPermissions'` at `gateway/wiring/substrate-profiles.ts:279` | profile suite: 2 failures | profile suite: green |
| bypass removal profile | `skip_permissions: false` → `true` at `gateway/wiring/substrate-profiles.ts:277` | profile suite: 2 failures | profile suite: green |
| restricted argv emission | `input.restricted === true` → `=== false` at `runtime/adapters/claude-code/persistent/build-repl-argv.ts:155` | argv suite: 1 failure | argv suite: green |
| prompt-policy argv emission | `permissionMode !== undefined` → `=== undefined` at `runtime/adapters/claude-code/persistent/build-repl-argv.ts:158` | argv suite: 1 failure | argv suite: green |

Every mutation was diffed and its landing line printed before the red run.

### Verification

- `bun test runtime/adapters/claude-code/persistent/__tests__/build-repl-argv.test.ts gateway/wiring/__tests__/substrate-profiles.test.ts` — 43 pass, 0 fail.
- `bunx tsc --noEmit -p runtime/tsconfig.json` — green.
- `bunx tsc --noEmit -p gateway/tsconfig.json` — green.
- `bun run typecheck` was attempted as requested; the repository has no such script, so the owning package configs above are the available equivalent.

### Deliberately not changed

Non-Trident profiles retain their existing bypass policy; this issue asked for every Trident agent, not the broader phased permission redesign. The arbiter remains tool-less rather than gaining read tools merely because restricted mode now exists. No feature flag, compatibility path, or alternate Trident launcher was added. No real authenticated model turn was run; the installed CLI's argument contract and incompatible-flags refusal were checked locally, while deterministic tests cover Neutron's complete profile-to-argv wiring.


## Review-lane correction — `dontAsk` on an ACTING profile is an off switch (2026-09-14)

The build lane shipped `permission_mode: 'dontAsk'` on all four Trident profiles and
validated it with unit tests over the profile constants and the emitted argv. Those
tests cannot see the defect, because the defect is in what the CLI then does.

MEASURED by the review lane against the installed `claude` 2.1.270, in a scratch
working directory, `--restricted --permission-mode dontAsk --tools Read,Write,Edit,Bash`:

| attempt (INSIDE the agent's own cwd) | result |
|---|---|
| `Write` a new file | DENIED — "Permission to use Write has been denied because Claude Code is running in don't ask mode" |
| `Bash: echo ok > f.txt` | DENIED — the same sentence for Bash |

No prompt is emitted, so the substrate's `tool-use-approve` detector
(`runtime/adapters/claude-code/persistent/repl-detectors.ts:95`) has nothing to answer.
`PROFILE_EPHEMERAL` is the dispatched-build and Trident-build substrate ("they commit
and push"), `PROFILE_LEAK_FIXER` "rewords a file and `git add`s it", and
`PROFILE_WARM_FIRE` is the warm workflow launcher: under `dontAsk` all three become
read-only, i.e. the autonomous build loop stops producing anything while every test in
this PR stays green. `PROFILE_ARBITER` is unaffected because it grants no tools at all.

Same binary, same directory, `--permission-mode acceptEdits` instead:

| attempt | result |
|---|---|
| `Write` a new file in cwd | ALLOWED, no prompt |
| `Bash: echo ok > f.txt` in cwd | ALLOWED, no prompt |
| `Read` a file OUTSIDE cwd | REFUSED by the CLI — "…is outside …; --restricted confines the file tools to the working directory" |
| `Bash: cat <outside file>` | REFUSED by the command gate — "may only concatenate files from the allowed working directories for this session" |
| `Bash: python3 -c "…open(<outside file>)…"` | "This command requires approval" — a PROMPT, not a refusal |

So the acting profiles now take `acceptEdits` and the arbiter keeps `dontAsk`, and a
regression case pins the distinction in BOTH directions
(`gateway/wiring/__tests__/substrate-profiles.test.ts`, "a profile whose agent must act
never carries the mode that denies every tool").

### The residual, named rather than implied

Confinement of the FILE tools and of recognised read commands is enforced by the CLI and
holds under `acceptEdits`. It does NOT hold for an arbitrary shell command the CLI cannot
classify: that escalates to an approval prompt, and the always-registered
`tool-use-approve` detector presses "1"+Enter on any tool-use prompt
(`runtime/adapters/claude-code/persistent/repl-detectors.ts:93-101`). A Bash-granted
Trident agent can therefore still reach outside its cwd by that route. This is strictly
narrower than today's `--dangerously-skip-permissions`, under which the file tools were
not confined either, and it is the residual the phase B/D sandbox migration has to close.
Closing it here would mean disabling the auto-approver for these profiles
(`no_auto_approve`), which would also leave legitimate in-cwd prompts unanswered — a
larger change than this issue, and not one to smuggle in.

All acting profiles name `Bash` in their `--tools` surface
(`trident/conflict-resolver.ts:RESOLVER_TOOL_NAMES`, `trident/inner-loop.ts:549`), so
`--restricted`'s removal of code-running tools "unless `--tools` names them" does not
apply to them. The repository has no `.claude/settings.json`, and `--settings` is always
emitted (`runtime/adapters/claude-code/persistent/build-repl-argv.ts:137`), so
`--restricted` ignoring user/project/local settings files costs nothing here and removes
one way a lane's own worktree could widen its grant.
