/** Native exit observations only schedule helper shutdown. A replacement still
 * needs the independent boot/birth death proof in the durable opener. */
export function ownerNativeStopObservation() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const stopped = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  // Bootstrap can fail before returning an owner to a consumer.
  stopped.catch(() => {})
  let observed = false
  return {
    stopped,
    observe(retiring: boolean, native: Promise<unknown> | undefined, terminal: Promise<unknown> | undefined): void {
      if (retiring || observed) return
      observed = true
      if (!native || !terminal) { reject(new Error('Native owner exit observations are incomplete')); return }
      Promise.all([native, terminal]).then(() => resolve(), reject)
    },
  }
}

/** One helper exit path, preserving the completed-retirement receipt ordering.
 * This closes the helper listener; it never terminates a child or mints a receipt. */
export async function finishOwnerHelperLifetime(helper: {
  retired: Promise<void>
  nativeStopped: Promise<void>
  finishRetirement(): Promise<void>
  finishNativeStop(): Promise<void>
}, exit: (code: number) => void): Promise<void> {
  const cause = await Promise.race([
    helper.retired.then(() => 'retired' as const),
    helper.nativeStopped.then(() => 'native-stopped' as const),
  ])
  if (cause === 'retired') await helper.finishRetirement()
  else await helper.finishNativeStop()
  exit(cause === 'retired' ? 0 : 1)
}
