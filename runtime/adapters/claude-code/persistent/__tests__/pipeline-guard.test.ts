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
    expect((await invoke('printf data | tail -f')).code).toBe(0)
    expect((await invoke('git commit -m "log | tail is mentioned"')).code).toBe(0)
  })

  test('cannot bypass the guard with paths, wrappers, separators, or alternate pipe syntax', () => {
    for (const command of [
      'run | /usr/bin/tail -n 2', 'run | env tail -20', 'run | \\tail',
      'run | tail; echo done', 'run | tail|head', 'run |& tail', "run | 'tail' -n 5",
      'run | wc -l', 'run | less', 'run | jq -s .', 'run | column -t', 'run | tac', 'run | sponge out',
    ]) expect(findBufferedPipelineConsumer(command), command).toBeDefined()
  })

  test('positive control: a live producer piped into tail -20 goes RED', async () => {
    expect(findBufferedPipelineConsumer('bun run long-build.ts | tail -20')).toBe('tail')
    const result = await invoke('bun run long-build.ts | tail -20')
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("full-buffering consumer 'tail'")
  })

  test('negative control: streaming through tee stays green', async () => {
    expect(findBufferedPipelineConsumer('bun run long-build.ts | tee build.log')).toBeUndefined()
    expect((await invoke('bun run long-build.ts | tee build.log')).code).toBe(0)
  })
})
