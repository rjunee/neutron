/** Await the first recovery pass before traffic, then retry unavailable terminal
 * hosts without requiring an app connection. A pass cannot overlap its successor.
 * This scheduler owns neither project admission nor workflow dispatch. */
export async function startProjectChatRecovery(
  recover: () => Promise<void>,
  onError: (error: unknown) => void,
  intervalMs = 30_000,
): Promise<() => Promise<void>> {
  let stopped = false
  let pending: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async (): Promise<void> => {
    try { await recover() } catch (error) { onError(error) }
    if (!stopped) {
      timer = setTimeout(() => { pending = run() }, intervalMs)
      timer.unref?.()
    }
  }
  pending = run()
  await pending
  return async () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    await pending
  }
}
