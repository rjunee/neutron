import { afterEach, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { seedMigratedDb } from '../../tests/support/migrated-db.ts'

const migration = readFileSync(new URL('../0146_rail_device_marks.sql', import.meta.url), 'utf8')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

for (const existingDeviceShape of [false, true]) {
  test(`migration seeds old aggregate; existing device shape: ${existingDeviceShape}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'rail-migration-'))
    dirs.push(dir)
    const path = join(dir, 'db')
    seedMigratedDb(path)
    const db = new Database(path)
    try {
      db.exec(`DROP TRIGGER rail_message_insert;
        DROP TRIGGER rail_receipt_insert; DROP TRIGGER rail_receipt_update;
        DELETE FROM rail_devices; DELETE FROM rail_device_marks;`)
      if (!existingDeviceShape) db.exec('DROP TABLE rail_devices; DROP TABLE rail_device_marks;')
      const message = db.query(`INSERT INTO app_chat_messages
        (topic_id, seq, message_id, role, body, created_at) VALUES (?, ?, ?, 'agent', 'body', 1)`)
      message.run('app:u:p', 1, 'm1')
      message.run('app:u:p', 2, 'm2')
      message.run('app:u', 1, 'general')
      message.run('app:v:p', 1, 'other')
      db.exec(`INSERT INTO app_chat_receipts
        (topic_id, message_id, device_id, seq, delivered_at, read_at) VALUES
        ('app:u:p', 'm2', 'phone', 2, 1, 1),
        ('app:u', 'general', 'desktop', 1, 1, NULL),
        ('app:v:p', 'other', 'foreign', 1, 1, 1);`)
      if (existingDeviceShape) db.exec(`INSERT INTO rail_device_marks VALUES ('app:u:p', 'phone', 1);`)
      db.exec(migration)
      expect(db.query(`SELECT device_id, seq FROM rail_device_marks WHERE topic_id = 'app:u:p' ORDER BY device_id`).all())
        .toEqual([{ device_id: 'desktop', seq: 2 }, { device_id: 'phone', seq: existingDeviceShape ? 1 : 2 }])
      expect(db.query('SELECT COUNT(*) AS n FROM app_chat_receipts').get()).toEqual({ n: 3 })
      // Legacy aggregate changes after migration cannot move the other device.
      message.run('app:u:p', 3, 'm3')
      db.exec(`INSERT INTO app_chat_receipts VALUES ('app:u:p', 'm3', 'phone', 3, 2, 2);`)
      expect(db.query(`SELECT seq FROM rail_device_marks WHERE topic_id = 'app:u:p' AND device_id = 'desktop'`).get()).toEqual({ seq: 2 })
      expect(db.query(`SELECT seq FROM rail_device_marks WHERE topic_id = 'app:u:p' AND device_id = 'phone'`).get()).toEqual({ seq: 3 })
    } finally { db.close() }
  })
}
