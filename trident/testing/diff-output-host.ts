/** Construct a fake host with the output-file behavior required by merge construction.
 * Existing files are preserved so fixtures can supply binary bytes directly.
 */
import { existsSync, writeFileSync } from 'node:fs'

type HostResult = { ok: boolean; exit_code: number; stdout: string; stderr: string }
type AnyHost<A extends unknown[]> = (cmd: string[], ...rest: A) => Promise<HostResult>

export function honourDiffOutput<A extends unknown[]>(
  host: AnyHost<A>,
): AnyHost<A> & { readonly writesDiffOutput: true } {
  const run: AnyHost<A> = async (cmd, ...rest) => {
    const result = await host(cmd, ...rest)
    const output = cmd.find((arg) => arg.startsWith('--output='))
    if (result.ok && output !== undefined) {
      const target = output.slice('--output='.length)
      if (!existsSync(target)) writeFileSync(target, result.stdout)
    }
    return result
  }
  return Object.assign(run, { writesDiffOutput: true as const })
}
