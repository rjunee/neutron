/** Manual native consumption, with a local model fixture and disposable homes.
 * bun run open/wiring/codex-owner-binding.smoke.ts
 * No subscription requests, shared homes, or live owner processes are touched.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexOwnerBindings } from './codex-owner-binding.ts'
import { bootstrapCodexOwner } from '@neutronai/runtime/adapters/codex-cli/persistent/project-control-bootstrap.ts'
import { buildLlmCallSubstrate } from '@neutronai/gateway/wiring/build-llm-call-substrate.ts'
import type { BoundedWorkRequest } from '@neutronai/runtime/bounded-work.ts'

const dir = mkdtempSync(join(tmpdir(), 'codex-owner-consumer-'))
const nativeInputs: string[] = []
const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const input = await request.text(); nativeInputs.push(input)
  const item = { id: 'fixture-answer', type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text: 'OWNER_REPLY', annotations: [] }] }
  const events = [
    { type: 'response.created', response: { id: 'fixture-response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OWNER_REPLY' },
    { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: 'OWNER_REPLY' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } })
} })
let launches = 0
const bindings = new CodexOwnerBindings(async projectId => {
  const cwd = join(dir, projectId), codexHome = join(cwd, 'home')
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  writeFileSync(join(codexHome, 'project-owner.json'), JSON.stringify(projectId))
  return { cwd, codexHome, env: { PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'C.UTF-8' } }
}, options => {
  launches++
  return bootstrapCodexOwner({ ...options, timeoutMs: 20_000,
    configOverrides: [...options.configOverrides ?? [], 'model_provider="fixture"', 'model="gpt-5.5"',
      `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false}`,
      'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false',
      `projects.${JSON.stringify(options.cwd)}.trust_level="trusted"`] })
})
const chat = buildLlmCallSubstrate({ resolvePool: async () => null, substrate_instance_id: 'native-owner-fixture',
  ownerConversation: true, provider: 'openai-codex', startCodexOwner: (id, spec) => bindings.start(id, spec) })!
async function turn(project: string, prompt: string): Promise<string> {
  let thread: string | undefined
  for await (const event of chat.start({ prompt, tools: [], model_preference: [],
    metering_context: { project_id: project }, turn_absolute_ceiling_ms: 25_000 }).events) {
    if (event.kind === 'error') throw new Error(event.message)
    if (event.kind === 'completion') thread = event.session?.id
  }
  assert(thread); return thread
}
try {
  const first = await turn('one', 'OWNER_ONE_FIRST')
  assert.equal(await turn('one', 'OWNER_ONE_SECOND'), first)
  const cwd = join(dir, 'one'), result = join(cwd, 'result.json')
  // A trailer cannot authorize a build when native subagent capability is absent.
  writeFileSync(result, JSON.stringify({ schema: 'fixture', run_id: 'run', step_id: 'step', kind: 'completed', result: {} }))
  const request: BoundedWorkRequest = { run_id: 'run', step_id: 'step', role: 'build', model_id: 'gpt-5.5', effort: null,
    cwd, writable: true, network: true, tools: 'edit-and-run', brief: { path: join(cwd, 'brief'), integrity: 'fixture' },
    result: { path: result, schema: 'fixture' }, thread: { id: first }, budget: { wall_ms: 25_000 }, needs_approval_decision: false }
  assert.equal((await bindings.actingTurn('one', 'topic-is-not-thread', cwd, [cwd])({
    conversation: { project_id: 'one', topic_id: 'topic-is-not-thread', provider: 'openai-codex', spec: { tools: [], model_preference: [] } },
    request, spec: { prompt: 'BUILD_DISPATCH', tools: [], model_preference: [] }, timeout_ms: 25_000, signal: new AbortController().signal,
  })).kind, 'refused')
  assert.equal(await turn('one', 'OWNER_ONE_AFTER_BUILD'), first)
  const second = await turn('two', 'OWNER_TWO_FIRST')
  assert.notEqual(first, second)
  assert.equal(launches, 2)
  assert.equal(nativeInputs.length, 4)
  assert(nativeInputs[2]!.includes('OWNER_ONE_FIRST') && !nativeInputs[2]!.includes('BUILD_DISPATCH'))
  assert(!nativeInputs[3]!.includes('OWNER_ONE_FIRST'))
  assert(!nativeInputs[0]!.includes('spawn_agent'))
  process.stdout.write('PASS: native owner chat/chat/refused-build/chat continuity and second-project isolation; one factory launch per project\n')
} finally {
  await bindings.close(); provider.stop(true); rmSync(dir, { recursive: true, force: true })
}
