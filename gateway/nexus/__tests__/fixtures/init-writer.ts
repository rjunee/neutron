import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { NexusStore } from '../../nexus-store.ts'

const [ownerHome, actor = 'writer'] = process.argv.slice(2)
if (!ownerHome) throw new Error('owner home required')
const store = new NexusStore({ owner_home: ownerHome })
try {
  const event = await store.appendEvent('race-project', {
    actor_kind: 'forge', actor_id: actor, kind: 'observation', body: actor, refs: null,
  })
  const db = new Database(join(ownerHome, 'Projects/race-project/.nexus/nexus.db'))
  const ledger = db.query('SELECT * FROM _migrations').all()
  db.close()
  console.log(JSON.stringify({ event, ledger }))
} finally {
  store.closeAll()
}
