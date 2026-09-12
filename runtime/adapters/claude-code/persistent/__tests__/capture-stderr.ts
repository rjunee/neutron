/**
 * capture-stderr.ts — the ONE sanctioned `process.stderr.write` override in the tests.
 *
 * WHY IT IS ITS OWN MODULE. Five suites hand-rolled this and all five got the same
 * two things wrong: the restore ran only on the happy path (so a rejecting `spawn`
 * left stderr patched for the rest of the process), and the "restore" installed
 * `original.bind(process.stderr)` — a DIFFERENT function object from the one it
 * replaced, so nested or repeated captures stack binds and nothing ever returns the
 * process to where it started. Both are the same family as a suite that points
 * `HERDR_SOCKET_PATH` at a dead path and never puts it back: process-wide state
 * borrowed without a guaranteed return.
 *
 * A guard in `tests/integration/pty-e2e-registered.test.ts` fails any test that
 * assigns `process.stderr.write` itself, so this file is the only place the
 * assignment lives.
 */
/**
 * Run `body` with `process.stderr.write` captured, and ALWAYS put it back.
 *
 * WHY A HELPER RATHER THAN THE PATTERN BY HAND. The hand-rolled version installs the
 * override, then does the interesting work, then restores — and the interesting work
 * here is `await host.spawn(...)`, which can reject: a protocol mismatch, an
 * unreachable socket, a pane that never reports a pid. When it does, the restore never
 * runs and `process.stderr.write` stays monkey-patched for the REST OF THE PROCESS,
 * contaminating every test after it. Two sites in this suite had exactly that shape,
 * including the live boundary proof — where the failure mode is at its worst: the one
 * test that can see a real server fails, and its failure silently degrades the run.
 *
 * Same family as a test that points `HERDR_SOCKET_PATH` at a dead path and never puts
 * it back: process-wide state borrowed without a guaranteed return.
 *
 * `tee` writes through to the real stderr as well, which a long live proof wants so a
 * human watching it still sees the output.
 */
/**
 * The SYNCHRONOUS sibling, for a body that is a pure function.
 *
 * Shares the one assignment site rather than duplicating it. The async form cannot serve
 * a synchronous body without making its caller `await`, and a second hand-rolled copy is
 * precisely what this module exists to prevent: five suites wrote that copy and all five
 * got the same two things wrong.
 */
export function withCapturedStderrSync(body: (lines: string[]) => void): string[] {
  const lines: string[] = []
  const original = process.stderr.write
  const realWrite = original.bind(process.stderr)
  process.stderr.write = ((c: unknown): boolean => {
    lines.push(String(c))
    void realWrite
    return true
  }) as typeof process.stderr.write
  try {
    body(lines)
  } finally {
    process.stderr.write = original
  }
  return lines
}

export async function withCapturedStderr(
  body: (lines: string[]) => Promise<void>,
  opts: { tee?: boolean } = {},
): Promise<string[]> {
  const lines: string[] = []
  // THE ORIGINAL REFERENCE IS WHAT GOES BACK, not a bound copy of it. Restoring
  // `original.bind(...)` leaves a DIFFERENT function object in place — functionally
  // equivalent, but nesting two captures then stacks binds and nothing ever returns the
  // process to the state it was in. Identity restored is the only restoration that
  // composes, and the test asserts identity for exactly that reason.
  const original = process.stderr.write
  const realWrite = original.bind(process.stderr)
  process.stderr.write = ((c: unknown): boolean => {
    lines.push(String(c))
    return opts.tee === true ? realWrite(String(c)) : true
  }) as typeof process.stderr.write
  try {
    await body(lines)
  } finally {
    process.stderr.write = original
  }
  return lines
}
