import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveResumeDirective } from '../spawn.ts'
import { classifyThrownSpawnError } from '../classify-spawn-error.ts'
import { SUBSTRATE_ERROR_CODES } from '../../../../errors.ts'
import type { PersistentReplSubstrateOptions } from '../types.ts'

for (const shape of ['ENOENT', 'missing-row', 'malformed-json', 'EISDIR', 'invalid-row', 'resumable'] as const) {
  test(`#676 resume directive: ${shape}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-resume-'))
    const path = join(dir, 'registry.json')
    const options: PersistentReplSubstrateOptions = { substrate_instance_id: 'resume-test', cwd: dir, replRegistryPath: path }
    const row = { sessionId: 'preserved-conversation', cwd: dir, channelName: `neutron-${'a'.repeat(32)}`, has_session: true }
    if (shape === 'missing-row') writeFileSync(path, JSON.stringify({ other: row }))
    if (shape === 'resumable') writeFileSync(path, JSON.stringify({ key: row }))
    if (shape === 'malformed-json') writeFileSync(path, '{broken')
    if (shape === 'EISDIR') mkdirSync(path)
    if (shape === 'invalid-row') writeFileSync(path, JSON.stringify({ key: { ...row, has_session: 'true' } }))
    try {
      if (shape === 'ENOENT' || shape === 'missing-row') {
        expect(resolveResumeDirective('key', options)).toBeUndefined()
      } else if (shape === 'resumable') {
        expect(resolveResumeDirective('key', options)).toEqual({ sessionId: row.sessionId })
      } else {
        let failure: unknown
        try { resolveResumeDirective('key', options) } catch (error) { failure = error }
        expect(failure).toBeInstanceOf(Error)
        const reason = shape === 'malformed-json' ? 'json-parse-error' : shape === 'EISDIR' ? 'read-error' : 'session row is invalid'
        expect((failure as Error).message).toContain(reason)
        expect((failure as Error).message).toContain('Retry the turn')
        expect(classifyThrownSpawnError(failure)).toBe('repl_unreconciled')
        expect(SUBSTRATE_ERROR_CODES.repl_unreconciled.retryable).toBe(true)
        rmSync(path, { recursive: true })
        writeFileSync(path, JSON.stringify({ key: row }))
        expect(resolveResumeDirective('key', options)).toEqual({ sessionId: row.sessionId })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
