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
    expect((await invoke('bun test | sort')).code).toBe(2)
  })

  test('REGRESSION: an instant producer into a buffering consumer is ALLOWED', async () => {
    // Shipped in #453 and deployed at 6d42ccf0, the guard keyed on the consumer alone and
    // refused all of these. The plan for this guard forbids exactly that: "`tail -20` AFTER
    // the producer has exited is safe and common; the rule is about consuming a LIVE
    // producer." Measured over ten realistic commands the first version refused six, and
    // only two were genuinely unsafe.
    for (const command of [
      'df -h / | tail -1',
      'git branch --list | wc -l',
      'git worktree list | wc -l',
      'ls -1 /tmp | sort | head',
      'ps aux | sort -rn | head',
      'printf data | sort',
      'echo hi | wc -c',
      'git log --oneline -5 | tail -2',
    ]) {
      expect(findBufferedPipelineConsumer(command), command).toBeUndefined()
      expect((await invoke(command)).code, command).toBe(0)
    }
  })

  test('a long-running producer is still caught through every stage of the pipe', () => {
    for (const command of [
      'bun test | tail -20',                 // direct
      'bun test 2>&1 | tee log | tail -5',   // through a streaming stage, and past `2>&1`
      'find / -name x | wc -l',              // whole-tree walk
      'du -sh /tmp | sort -h',
      'curl -s https://example.com | sort',
      'git fetch origin main | wc -l',       // the git subcommands that touch the network
      'tail -f app.log | wc -l',             // a follower never ends
      'env bun test | sort',                 // wrapper on the producer side
      'ls | wc -l; bun test | tail -3',      // the offender is the SECOND statement
    ]) expect(findBufferedPipelineConsumer(command), command).toBeDefined()
  })

  test('allows a streaming pipeline', async () => {
    expect(findBufferedPipelineConsumer('printf data | grep data')).toBeUndefined()
    expect((await invoke('printf data | grep data')).code).toBe(0)
    expect((await invoke('printf data | tail -f')).code).toBe(0)
    expect((await invoke('git commit -m "log | tail is mentioned"')).code).toBe(0)
  })

  test('cannot bypass the guard with paths, wrappers, separators, or alternate pipe syntax', () => {
    for (const command of [
      'bun test | /usr/bin/tail -n 2', 'bun test | env tail -20', 'bun test | \\tail',
      'bun test | tail; echo done', 'bun test | tail|head', 'bun test |& tail', "bun test | 'tail' -n 5",
      'bun test | wc -l', 'bun test | less', 'bun test | jq -s .', 'bun test | column -t', 'bun test | tac', 'bun test | sponge out',
    ]) expect(findBufferedPipelineConsumer(command), command).toBeDefined()
  })

  test('a heredoc BODY is data, not shell — and a real offender after it is still caught', () => {
    // Measured 2026-08-21: the deployed guard refused a `python3 - <<PY ... PY` call whose
    // only offence was that its Python string literals contained example pipelines.
    const writeFixture = [
      "python3 - <<'PY'",
      "cases = ['bun test | tail -20', 'find / | wc -l']",
      'PY',
    ].join('\n')
    expect(findBufferedPipelineConsumer(writeFixture)).toBeUndefined()

    // Anti-fake: the skipper must not swallow the rest of the command.
    expect(findBufferedPipelineConsumer(`${writeFixture}\nbun test | tail -3`)).toBe('tail')
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
