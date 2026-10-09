/**
 * Teardown for a test fixture that boots the real Open composition.
 *
 * THE HAZARD. A composed boot registers `realmode_cleanups`, and some of them are
 * async: the chunked-upload sweeper's cleanup is a quiescing `stop()` that waits
 * for an in-flight tick (a real SQLite write) to finish. Calling those cleanups
 * without awaiting them and then closing the database lets SQLite close under a
 * write that is still running.
 *
 * This helper does not drain the cleanups itself. It hands them to the gateway's
 * production drain, `drainRealmodeCleanups`, which awaits each one in
 * registration order, logs and continues after a throw or rejection, and always
 * resolves. Only after that drain settles does it shut the graph down and close
 * the database, the same order the gateway's own shutdown uses.
 */

import { drainRealmodeCleanups } from '@neutronai/gateway/index.ts'
import type { CompositionInput } from '@neutronai/gateway/composition.ts'

export interface FixtureTeardownParts {
  readonly cleanups: CompositionInput['realmode_cleanups']
  readonly graph: { shutdown(): Promise<unknown> }
  readonly db: { close(): void }
}

export async function teardownComposedFixture(parts: FixtureTeardownParts): Promise<void> {
  await drainRealmodeCleanups(parts.cleanups ?? [])
  await parts.graph.shutdown()
  parts.db.close()
}
