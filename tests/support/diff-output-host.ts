/**
 * diff-output-host.ts — every fake `run_host` must model `git diff --output=`.
 *
 * THE SIZE GATE NO LONGER READS STDOUT (#777). `enforceMergeDiffGate` runs
 * `git diff … --output=<path>` and measures the FILE, so the whole diff never
 * enters the process's heap — which was the point: the pathological diff the
 * gate exists to refuse was previously read in full before being refused.
 *
 * That moved the gate's evidence off the `run_host` seam. A fake that answers on
 * stdout alone writes no patch file, and the gate — which fails closed, because
 * "nothing wrote a patch" must never be measured as "zero bytes" — HOLDS. So a
 * suite with no interest in diff size fails for a diff-size reason. Measured
 * three times: `merge.test.ts`, `orchestrator.test.ts`, and
 * `arbiter-wiring.test.ts`, the last of which is about merge-conflict arbitration
 * and never mentions the gate.
 *
 * Wrap a fake host in this and it behaves like the real command. It writes only
 * when the command SUCCEEDED and only when the file is not already there, so a
 * responder that deliberately models an unwritten patch (the fail-closed case)
 * keeps working.
 */
import { existsSync, writeFileSync } from 'node:fs'

type HostResult = { ok: boolean; exit_code: number; stdout: string; stderr: string }
type AnyHost<A extends unknown[]> = (cmd: string[], ...rest: A) => Promise<HostResult>

export function honourDiffOutput<A extends unknown[]>(host: AnyHost<A>): AnyHost<A> {
  return async (cmd, ...rest) => {
    const result = await host(cmd, ...rest)
    const output = cmd.find((arg) => arg.startsWith('--output='))
    if (result.ok && output !== undefined) {
      const target = output.slice('--output='.length)
      if (!existsSync(target)) writeFileSync(target, result.stdout)
    }
    return result
  }
}
