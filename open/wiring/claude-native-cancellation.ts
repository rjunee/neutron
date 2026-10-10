import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'
import type { NativeChildAdmission } from '@neutronai/gateway/project-admission.ts'
import type { TridentRun } from '@neutronai/trident/store.ts'
import { cancelClaudeNativeChild, reconcileClaudeNativeCancellation, NATIVE_CANCELLATION_MS, type NativeCancellationOutcome } from '@neutronai/runtime/workers/claude-native-cancellation.ts'
import { readClaudeNativeDispatchReceipt, type SignedNativeDispatchRecord } from '@neutronai/runtime/workers/claude-native-dispatch-receipt.ts'
import { resolveLiveProjectSessions } from '@neutronai/runtime/adapters/claude-code/persistent/live-project-sessions.ts'
import { resolveTranscriptProjectsDir } from '@neutronai/runtime/adapters/claude-code/persistent/signatures.ts'
import { admitNativeChildWorkspace, completeNativeChildWorkspace, completeNativeChildWorkspaceRequest } from '@neutronai/runtime/workers/native-child-workspace.ts'
import { releasePlannerWork } from '@neutronai/runtime/workers/planner-work.ts'

const exec = promisify(execFile)

export async function cancelOriginalClaudeChild(options: {
  request: BoundedWorkRequest
  projectId: string
  stateDir: string
  admission: NativeChildAdmission
  run(): TridentRun | null
  git?(args: string[], cwd: string, signal: AbortSignal): Promise<string>
}): Promise<NativeCancellationOutcome> {
  const unknown = (): NativeCancellationOutcome => ({ kind: 'unknown', reason: 'identity' })
  try {
    const { request, admission } = options
    const receipt = readClaudeNativeDispatchReceipt(options.stateDir, request)
    const authority = admission.cancellation?.(request, receipt)
    if (!authority || !admission.pending) return unknown()
    // Authentication above precedes reading any retained request/parent fields.
    const signed = receipt as SignedNativeDispatchRecord
    const eligible = () => {
      const run = options.run()
      return run?.id === request.run_id && (run.phase === 'stopped'
        || Number.isSafeInteger(signed.body.deadlineMs) && Date.now() >= signed.body.deadlineMs!)
    }
    if (!eligible()) return unknown()
    const boundedAuthority = { ...authority, current: () => eligible() && authority.current() }
    const retained = await reconcileClaudeNativeCancellation(request, receipt, boundedAuthority)
    if (retained) {
      if (retained.kind === 'stopped') {
        const parents = await resolveLiveProjectSessions([options.projectId])
        for (const { session } of parents.live) {
          completeNativeChildWorkspaceRequest(session, request); releasePlannerWork(session, request)
        }
      }
      return retained
    }
    const run = options.run()!
    if (!run.worktree || !run.branch) return unknown()
    const parents = await resolveLiveProjectSessions([options.projectId])
    if (parents.unresolved !== 0 || parents.live.length !== 1) return unknown()
    const { session, options: spawnOptions } = parents.live[0]!
    if (session.sessionId !== signed.body.parent?.sessionId || spawnOptions.skip_permissions !== true
      || spawnOptions.restricted || spawnOptions.permissions) return unknown()
    const deadline = Date.now() + NATIVE_CANCELLATION_MS, signal = AbortSignal.timeout(NATIVE_CANCELLATION_MS)
    const workspace = await admitNativeChildWorkspace({ session, request, runId: run.id,
      worktree: run.worktree, branch: run.branch, generation: authority.lease.generation,
      pending: () => admission.pending!(), git: async args => options.git ? options.git(args, run.worktree!, signal)
        : (await exec('git', ['-C', run.worktree!, ...args], { signal, timeout: Math.max(1, deadline - Date.now()), maxBuffer: 64 * 1024 })).stdout.trim() })
    try {
      const outcome = await cancelClaudeNativeChild({ request, receipt, stateDir: options.stateDir, session, workspace,
        authority: boundedAuthority,
        projectsDir: resolveTranscriptProjectsDir(spawnOptions), deadline, signal })
      if (outcome.kind === 'stopped') {
        completeNativeChildWorkspaceRequest(session, request)
        releasePlannerWork(session, request)
      }
      return outcome
    } finally {
      // Retire only this temporary reconstruction. Unacknowledged original work
      // keeps its durable lease and any original workspace/turn ownership.
      completeNativeChildWorkspace(workspace)
    }
  } catch { return unknown() }
}
