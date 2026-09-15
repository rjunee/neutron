import { expect, test } from 'bun:test'
import { FAST_MODEL, PROBE_MODEL } from '../models.ts'

// WHY THIS TEST EXISTS. `PROBE_MODEL` used to alias `FAST_MODEL`, which is the CLI
// alias `'haiku'`. That is correct for anything that spawns a `claude` process — the
// CLI resolves aliases itself. It is WRONG for `PROBE_MODEL`, which is sent as the
// `model` field of a raw `POST https://api.anthropic.com/v1/messages`, where an alias
// answers `404 {"type":"not_found_error","message":"model: haiku"}`.
//
// The failure was silent and expensive to diagnose: a 404 carries no
// `anthropic-ratelimit-unified-*` headers, so the usage probe read no windows and
// reported `no-windows`. Every usage surface then drew its documented "unknown"
// fallback — the plain divider — and the owner's usage meter simply vanished while
// the credential was healthy. Nothing logged it.
//
// Every existing probe test injects a fake `fetch`, so none of them could ever catch
// an unaddressable model id. This one checks the SHAPE the API requires instead.

test('PROBE_MODEL is a fully-qualified model id, not a CLI alias', () => {
  // The API accepts `claude-<family>-<version>-<YYYYMMDD>`; it rejects bare aliases.
  expect(PROBE_MODEL).toMatch(/^claude-[a-z0-9.-]+-\d{8}$/)
  expect(PROBE_MODEL).not.toBe('haiku')
})

test('PROBE_MODEL is decoupled from FAST_MODEL, because their requirements differ', () => {
  // FAST_MODEL feeds CLI spawns and is an alias ON PURPOSE. The positive control:
  // if this ever stops being an alias the comment above needs revisiting, but the
  // decoupling assertion below is what must hold.
  expect(FAST_MODEL).toBe('haiku')
  expect(PROBE_MODEL).not.toBe(FAST_MODEL)
})
