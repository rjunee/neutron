#!/usr/bin/env bun
/**
 * PreToolUse deny-guard hook for trident v2 auto mode.
 *
 * Wired into the inner-loop launcher's `--settings` (see `trident/auto-mode.ts`
 * `buildTridentAutoModeSettings`) as a `PreToolUse` hook matched on `Bash`. CC
 * runs it BEFORE every Bash tool call: it reads the tool JSON on stdin and emits
 * a `permissionDecision` of `deny` for the destructive command shapes the coarse
 * allow/deny globs cannot express (push-to-main, rm -rf of a system/home root,
 * history rewrites, force-deleting a protected branch, curl|bash). A deny is
 * RETURNED to the agent (which adapts/reports under the inlined no-interactive
 * rule) — it never hangs, never silently proceeds. Anything not denied here
 * `exit 0`s with no output, deferring to the dontAsk allowlist.
 *
 * A `deny` here is HARD: deny always beats a hook `allow` and the allowlist, so
 * this is purely an ADDITIONAL guardrail (it never widens the grant surface).
 *
 * Hook contract (CC ~2.1.195):
 *   stdin:  { tool_name, tool_input: { command, ... }, cwd, ... }
 *   stdout (to deny): { hookSpecificOutput: { hookEventName: "PreToolUse",
 *                       permissionDecision: "deny", permissionDecisionReason } }
 *   exit 0 with no stdout = defer (allow per the allowlist).
 *
 * The decision logic is the PURE `evaluateBashDenyGuard` (unit-tested in
 * `trident/auto-mode.test.ts`); this file is only the stdin/stdout shell. It
 * FAILS OPEN on a malformed payload (exit 0) so the guard never wedges a build —
 * the deny list + dontAsk remain in force regardless.
 */

import { evaluateBashDenyGuard } from '../auto-mode.ts'

interface PreToolUseInput {
  tool_name?: string
  tool_input?: { command?: string } & Record<string, unknown>
  cwd?: string
}

async function main(): Promise<void> {
  let input: PreToolUseInput = {}
  try {
    const raw = await Bun.stdin.text()
    if (raw.trim()) input = JSON.parse(raw) as PreToolUseInput
  } catch {
    process.exit(0) // fail open — don't wedge a build on a malformed payload.
  }

  // Only Bash carries a destructive command shape; other tools defer.
  if (input.tool_name !== undefined && input.tool_name !== 'Bash') process.exit(0)

  const command = input.tool_input?.command
  if (typeof command !== 'string' || command.trim() === '') process.exit(0)

  const decision = evaluateBashDenyGuard(
    command,
    input.cwd !== undefined ? { worktreeRoot: input.cwd } : {},
  )
  if (!decision.deny) process.exit(0)

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason ?? 'blocked by trident auto-mode deny-guard',
      },
    }),
  )
  process.exit(0)
}

main().catch(() => process.exit(0))
