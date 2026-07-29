/**
 * RC1 test fixture — one first-write to a (possibly fresh) nexus
 * sidecar, from a REAL separate process.
 *
 * Usage: bun run append-first-write.ts <owner_home> <project_id> <body> <go_file>
 *
 * Constructs a NexusStore, then spin-waits for `go_file` to exist so
 * the parent test can release N of these processes at (near) the same
 * instant — that makes the fresh-sidecar migration race
 * (`applyMigrationsWithInitRaceRetry`'s two failure modes) genuinely
 * cross-process, not same-thread interleaving. Prints the written
 * event id on success (exit 0); prints the error and exits 1 on
 * failure.
 */

import { existsSync } from 'node:fs'

import { NexusStore } from '../../nexus-store.ts'

const [owner_home, project_id, body, go_file] = process.argv.slice(2)
if (
  owner_home === undefined ||
  project_id === undefined ||
  body === undefined ||
  go_file === undefined
) {
  console.error('usage: append-first-write.ts <owner_home> <project_id> <body> <go_file>')
  process.exit(2)
}

// Barrier: boot fully (imports resolved, store constructed), signal
// READY, THEN wait for the parent's go signal — the parent releases
// the go file only once EVERY sibling printed READY, so all processes
// hit first-init together (µs-ms apart, not boot-jitter apart).
const store = new NexusStore({ owner_home })
console.log('READY')
const deadline = Date.now() + 15_000
while (!existsSync(go_file)) {
  if (Date.now() > deadline) {
    console.error('timed out waiting for go file')
    process.exit(2)
  }
  await Bun.sleep(1)
}

try {
  const event = await store.appendEvent(project_id, {
    actor_kind: 'forge',
    actor_id: `pid-${process.pid}`,
    kind: 'observation',
    body,
    refs: null,
  })
  console.log(event.id)
  store.closeAll()
  process.exit(0)
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
  process.exit(1)
}
