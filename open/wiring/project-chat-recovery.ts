/** Await the first recovery pass before traffic, then retry unavailable terminal
 * hosts without requiring an app connection. A pass cannot overlap its successor.
 * This scheduler owns neither project admission nor workflow dispatch. */
export function startProjectChatRecovery(
  recover: () => Promise<void>,
  onError: (error: unknown) => void,
  intervalMs = 30_000,
): { ready: Promise<void>; stop: () => Promise<void> } {
  let stopped = false
  let pending: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async (): Promise<void> => {
    if (stopped) return
    try { await recover() } catch (error) { onError(error) }
    if (!stopped) {
      timer = setTimeout(() => { pending = run() }, intervalMs)
      timer.unref?.()
    }
  }
  // Publish the stop capability before any recovery runs, including the first
  // pass. Callers can quiesce a held initial pass rather than waiting for ready
  // to obtain the very handle needed to stop it.
  pending = Promise.resolve().then(run)
  return {
    ready: pending,
    stop: async () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      await pending
    },
  }
}
