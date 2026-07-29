/**
 * @neutronai/gbrain-memory — command-runner seam (git ls-remote + bun install).
 *
 * Extracted (L3, 2026-07) out of `gbrain-doctor.ts` into its own leaf so the
 * `ensure-brain-init.ts` → `gbrain-doctor.ts` static import edge is cut:
 * `ensure-brain-init` only needs the `CommandRunner` seam + the `bunCommandRunner`
 * default, while `gbrain-doctor` dynamically imports `ensure-brain-init` (to avoid
 * the reverse static edge). Pulling the runner seam here lets both import it
 * without the static cycle. `gbrain-doctor.ts` re-exports these symbols
 * (test-policy §2.2 barrel rule) so existing import specifiers stay valid.
 */

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<CommandResult>
}

/** Real runner over `Bun.spawn`, with a hard timeout so a wedged child can't hang the doctor. */
export function bunCommandRunner(): CommandRunner {
  return {
    async run(cmd, args, opts) {
      // INHERIT the caller's environment, then layer overrides. `bun install -g`
      // resolves the global bin dir from HOME/BUN_INSTALL, and both bun + `git
      // ls-remote` may need proxy/cert env (HTTP(S)_PROXY, *_CA_*) — a minimal
      // {PATH-only} env would silently break the upgrade in scheduled/CI runs or
      // install the binary into the wrong global dir (Codex r1 P2).
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') env[k] = v
      }
      if (opts?.env !== undefined) Object.assign(env, opts.env)
      const proc = Bun.spawn([cmd, ...args], {
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env,
      })
      const timeoutMs = opts?.timeoutMs ?? 30_000
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill()
      }, timeoutMs)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        if (timedOut) {
          return { code: 124, stdout, stderr: `${stderr}\n[gbrain-doctor] timed out after ${timeoutMs}ms` }
        }
        return { code, stdout, stderr }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
