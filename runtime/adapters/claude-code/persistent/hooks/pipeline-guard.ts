#!/usr/bin/env bun

interface HookInput {
  tool_name?: string
  tool_input?: { command?: unknown }
}

const FULL_BUFFERING_CONSUMERS = new Set(['tail', 'sort', 'wc', 'less', 'tac', 'sponge'])

/**
 * The rule is about consuming a LIVE producer — the plan for this guard says so in as many
 * words: "`tail -20` AFTER the producer has exited is safe and common". A buffering consumer
 * only withholds activity for as long as its producer keeps running, so `df -h / | tail -1`
 * costs nothing while `bun test | tail -20` can starve the inactivity timeout for minutes.
 *
 * The first shipped version keyed on the consumer alone and refused both. Measured over ten
 * realistic commands it refused six and only two of those were genuinely unsafe: two thirds
 * of its refusals were the exact false positive the plan forbade. A refusal is a hard,
 * immediate failure of the agent's turn, whereas a miss only risks a timeout on a command
 * that used to be unguarded prose anyway — so this asks about the PRODUCER, and stays quiet
 * unless it recognises one that really runs long.
 */
const LONG_RUNNING_PRODUCERS = new Set([
  // test runners, builds, package managers
  'bun', 'npm', 'pnpm', 'yarn', 'node', 'deno', 'tsc', 'jest', 'vitest', 'mocha',
  'cargo', 'go', 'make', 'gradle', 'mvn', 'bazel', 'webpack', 'vite', 'esbuild',
  // containers / infra / remote
  'docker', 'podman', 'kubectl', 'terraform', 'ansible', 'ssh', 'rsync', 'scp',
  // network fetches
  'curl', 'wget', 'gh', 'aws', 'gcloud',
  // agents
  'codex', 'claude',
  // whole-tree walks
  'find', 'du', 'rsync', 'tar', 'zip', 'unzip',
  // deliberate waits
  'sleep', 'watch', 'journalctl', 'dmesg',
])

/** `git` is usually instant metadata; only these subcommands touch the network or repack. */
const LONG_RUNNING_GIT_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'gc', 'repack', 'filter-branch', 'bisect'])

/** Does this pipeline stage keep producing long enough to starve the inactivity timeout? */
function isLongRunningProducer(words: string[]): boolean {
  const argv = [...words]
  while (argv[0] === 'command' || argv[0] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? '')) argv.shift()
  const executable = (argv.shift() ?? '').replace(/^\\/, '').split('/').at(-1) ?? ''
  if (executable === '') return false
  // A follower never ends on its own, whatever it is.
  if (argv.some((word) => word === '-f' || word === '--follow')) return true
  if (executable === 'git') return LONG_RUNNING_GIT_SUBCOMMANDS.has(argv.find((w) => !w.startsWith('-')) ?? '')
  return LONG_RUNNING_PRODUCERS.has(executable)
}

function pipelineSegments(command: string): string[] {
  const segments: string[] = []
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!
    if (escaped) { escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote !== undefined) { if (char === quote) quote = undefined; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '|' && command[i - 1] !== '|') {
      let start = i + 1
      if (command[start] === '&') start += 1
      let end = start
      let innerQuote: "'" | '"' | undefined
      for (; end < command.length; end += 1) {
        const next = command[end]!
        if (innerQuote !== undefined) { if (next === innerQuote) innerQuote = undefined; continue }
        if (next === "'" || next === '"') { innerQuote = next; continue }
        if (next === '|' || next === ';' || next === '\n') break
      }
      segments.push(command.slice(start, end))
    }
  }
  return segments
}

function shellWords(segment: string): string[] {
  return segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, '$2')) ?? []
}

/**
 * Remove heredoc BODIES before parsing. A heredoc is data, not shell: the body of
 * `python3 - <<'PY' ... PY` may quote example pipelines, and the raw-text scanner reads them
 * as commands. This is not hypothetical — writing this guard's own test fixtures was refused
 * by the deployed guard because the fixture strings contained `bun test | tail`.
 *
 * The delimiter line is kept so nothing is silently glued together.
 */
export function stripHeredocBodies(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  let marker: string | undefined
  for (const line of lines) {
    if (marker !== undefined) {
      if (line.trim() === marker) marker = undefined
      continue
    }
    kept.push(line)
    // `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"` — the last one on the line wins.
    const opens = [...line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g)]
    const last = opens.at(-1)
    if (last !== undefined) marker = last[2]
  }
  return kept.join('\n')
}

/**
 * Split into pipelines, each a list of stages in order. Unlike `pipelineSegments`, the
 * PRODUCER (stage 0) is kept — the guard cannot judge a consumer without knowing what feeds
 * it. `;` and newline start a new pipeline, so a later statement's producer is never
 * attributed to an earlier statement's consumer.
 */
export function pipelineStagesByStatement(command: string): string[][] {
  const pipelines: string[][] = []
  let stages: string[] = []
  let current = ''
  let quote: "'" | '"' | undefined
  let escaped = false
  const endStage = (): void => { stages.push(current); current = '' }
  const endPipeline = (): void => {
    endStage()
    if (stages.some((s) => s.trim() !== '')) pipelines.push(stages)
    stages = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!
    if (escaped) { current += char; escaped = false; continue }
    if (char === '\\' && quote !== "'") { current += char; escaped = true; continue }
    if (quote !== undefined) { current += char; if (char === quote) quote = undefined; continue }
    if (char === "'" || char === '"') { current += char; quote = char; continue }
    if (char === '|' && command[i + 1] === '|') { endPipeline(); i += 1; continue }
    if (char === '|' && command[i - 1] !== '|') {
      endStage()
      if (command[i + 1] === '&') i += 1
      continue
    }
    // `&&` separates statements. A LONE `&` does NOT — `2>&1` is a redirect, and treating it
    // as a separator severed `bun test 2>&1 | tee log | tail -5` from its producer and let
    // the real offender through.
    if (char === '&' && command[i + 1] === '&') { endPipeline(); i += 1; continue }
    if (char === ';' || char === '\n') { endPipeline(); continue }
    current += char
  }
  endPipeline()
  return pipelines
}

/** The buffering consumer, if any, that this stage is. */
function bufferingConsumerName(words: string[]): string | undefined {
  const argv = [...words]
  while (argv[0] === 'command' || argv[0] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0] ?? '')) argv.shift()
  const executable = (argv.shift() ?? '').replace(/^\\/, '').split('/').at(-1) ?? ''
  if (FULL_BUFFERING_CONSUMERS.has(executable)) {
    // `tail -f` streams; it is not waiting for EOF.
    if (executable === 'tail' && argv.some((word) => word === '-f' || word === '--follow' || /^-[^-]*f/.test(word))) return undefined
    return executable
  }
  if (executable === 'jq' && argv.some((word) => word === '-s' || word === '--slurp' || /^-[^-]*s/.test(word))) return 'jq -s'
  if (executable === 'column' && argv.some((word) => word === '-t' || word === '--table' || /^-[^-]*t/.test(word))) return 'column -t'
  return undefined
}

/**
 * Return the first full-buffering consumer that is fed by a LIVE (long-running) producer.
 *
 * Both halves must hold. A buffering consumer downstream of nothing but instant producers is
 * harmless and must not be refused; a long producer feeding a streaming consumer (`| tee`,
 * `| grep`) is exactly the shape the rule tells agents to use.
 */
export function findBufferedPipelineConsumer(command: string): string | undefined {
  for (const stages of pipelineStagesByStatement(stripHeredocBodies(command))) {
    let upstreamIsLive = false
    for (const [index, stage] of stages.entries()) {
      const words = shellWords(stage)
      if (index > 0 && upstreamIsLive) {
        const consumer = bufferingConsumerName(words)
        if (consumer !== undefined) return consumer
      }
      if (isLongRunningProducer(words)) upstreamIsLive = true
    }
  }
  return undefined
}

async function main(): Promise<void> {
  let input: HookInput
  try {
    input = JSON.parse(await Bun.stdin.text()) as HookInput
  } catch {
    process.exit(0)
  }
  if (input.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') process.exit(0)
  const offender = findBufferedPipelineConsumer(input.tool_input.command)
  if (offender === undefined) process.exit(0)
  process.stderr.write(
    `Refused Bash call: pipeline output may not be sent to full-buffering consumer '${offender}' during a chat turn. Redirect to a log file and inspect it in a separate call.\n`,
  )
  process.exit(2)
}

if (import.meta.main) main().catch(() => process.exit(0))
