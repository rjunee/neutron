import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { findBufferedPipelineConsumer } from '../hooks/pipeline-guard.ts'

const HOOK = join(import.meta.dir, '..', 'hooks', 'pipeline-guard.ts')

async function invoke(command: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['bun', HOOK], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  proc.stdin.write(JSON.stringify({ tool_name: 'Bash', tool_input: { command } }))
  proc.stdin.end()
  return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
}

describe('chat Bash pipeline guard', () => {
  test('refuses a pipeline into tail and names the offending call', async () => {
    expect(findBufferedPipelineConsumer('bun test | tail -n 20')).toBe('tail')
    const result = await invoke('bun test | tail -n 20')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("full-buffering consumer 'tail'")
    expect(result.stderr).toContain('Refused Bash call')
  })

  test('refuses a pipeline into sort', async () => {
    expect((await invoke('printf data | sort')).code).toBe(2)
  })

  test('allows a streaming pipeline', async () => {
    expect(findBufferedPipelineConsumer('printf data | grep data')).toBeUndefined()
    expect((await invoke('printf data | grep data')).code).toBe(0)
  })
})
