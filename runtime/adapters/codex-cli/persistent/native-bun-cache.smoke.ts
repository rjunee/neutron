/** Consuming smoke: real native app-server -> direct exec_command -> Bun install.
 * Uses a local fake provider, disposable homes, and cached packages only.
 * NATIVE_BUN_SMOKE_SOURCE must name a cache containing react/react-dom 19.1.0,
 * scheduler 0.26.0 and TypeScript 5.9.3. No live credential or owner is used.
 */
import assert from 'node:assert/strict'
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectControlStdioTransport, type ProjectControlTransport } from './project-control-broker-transport.ts'
import { prepareNativeBunCache } from './native-bun-cache.ts'

type Rpc = Record<string, any>
async function main(): Promise<void> {
  const inputCache = process.env.NATIVE_BUN_SMOKE_SOURCE
  if (!inputCache) throw new Error('NATIVE_BUN_SMOKE_SOURCE must name the explicit fixture package cache')
  const root = mkdtempSync(join(tmpdir(), 'native-bun-smoke-'))
  const source = join(root, 'source'), cwd = join(root, 'owner'), codexHome = join(root, 'home')
  for (const path of [source, cwd, codexHome]) mkdirSync(path, { mode: 0o700 })
  const mirror = (from: string, to: string): void => {
    mkdirSync(to, { mode: 0o700 })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) mirror(join(from, entry.name), join(to, entry.name))
      else if (entry.isFile()) linkSync(join(from, entry.name), join(to, entry.name))
      else throw new Error('Smoke cache fixture must contain regular package files')
    }
  }
  for (const name of ['react@19.1.0@@@1', 'react-dom@19.1.0@@@1', 'scheduler@0.26.0@@@1', 'typescript@5.9.3@@@1']) {
    mirror(join(inputCache, name), join(source, name))
  }
  const cache = prepareNativeBunCache(source, tmpdir(), process.getuid!())
  const lock = {
    lockfileVersion: 1, configVersion: 1,
    workspaces: { '': { name: 'native-cache-fixture', dependencies: { react: '19.1.0', 'react-dom': '19.1.0', typescript: '5.9.3' } } },
    packages: {
      react: ['react@19.1.0', '', {}, 'sha512-FS+XFBNvn3GTAWq26joslQgWNoFu08F4kl0J4CgdNKADkdSGXQyTCnKteIAJy96Br6YbpEU1LSzV5dYtjMkMDg=='],
      'react-dom': ['react-dom@19.1.0', '', { dependencies: { scheduler: '^0.26.0' }, peerDependencies: { react: '^19.1.0' } }, 'sha512-Xs1hdnE+DyKgeHJeJznQmYMIBG3TKIHJJT95Q58nHLSrElKlGQqDTR2HQ9fx5CN/Gk6Vh/kupBTDLU11/nDk/g=='],
      scheduler: ['scheduler@0.26.0', '', {}, 'sha512-NlHwttCI/l5gCPR3D1nNXtWABUmBwvZpEQiD4IXSbIDq8BzLIK/7Ir5gTFSGZDUu37K5cMNp0hFtzO38sC7gWA=='],
      typescript: ['typescript@5.9.3', '', { bin: { tsc: 'bin/tsc', tsserver: 'bin/tsserver' } }, 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=='],
    },
  }
  const worktrees = ['first', 'second'].map(name => {
    const path = join(root, name); mkdirSync(path)
    writeFileSync(join(path, 'package.json'), JSON.stringify({ ...lock.workspaces[''], private: true }))
    writeFileSync(join(path, 'bun.lock'), JSON.stringify(lock))
    writeFileSync(join(path, 'valid.ts'), 'export const total: number = 7\n')
    writeFileSync(join(path, 'invalid.ts'), "export const total: number = 'broken'\n")
    writeFileSync(join(path, 'runtime.test.ts'), "import {test,expect} from 'bun:test'; import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; test('peer resolves',()=>expect(renderToStaticMarkup(createElement('p',null,'readable'))).toBe('<p>readable</p>'))\n")
    return path
  })
  let commandIndex = 0, completed = false
  const outputs: string[] = []
  const commands: Rpc[] = []
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Rpc
    outputs.push(JSON.stringify(body.input))
    const index = commandIndex++
    const item: Rpc = index < worktrees.length
      ? { type: 'function_call', id: `install-${index}`, call_id: `install-${index}`, name: 'exec_command', status: 'completed',
        arguments: JSON.stringify({ workdir: worktrees[index], cmd: 'printenv BUN_INSTALL_CACHE_DIR && bun install --frozen-lockfile --ignore-scripts && bun test runtime.test.ts && bunx --no-install tsc --noEmit --target ES2022 --lib es2022 valid.ts && if bunx --no-install tsc --noEmit --target ES2022 --lib es2022 invalid.ts; then exit 91; fi', yield_time_ms: 10000, max_output_tokens: 2000 }) }
      : { type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id: `response-${index}`, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `response-${index}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
  } })
  let transport: ProjectControlTransport | undefined
  try {
    transport = createProjectControlStdioTransport({ binary: 'codex', cwd, codexHome,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: codexHome, BUN_INSTALL_CACHE_DIR: source },
      configOverrides: ['model_provider="fixture"', 'model="gpt-5.5"', 'features.code_mode=false', 'analytics.enabled=false', 'feedback.enabled=false', 'check_for_update_on_startup=false',
        `model_providers.fixture={name="fixture",base_url="http://127.0.0.1:${provider.port}/v1",wire_api="responses",requires_openai_auth=false}`],
    })
    let sequence = 0
    const pending = new Map<number, { resolve(value: Rpc): void; reject(error: Error): void }>()
    transport.listen(raw => {
      const message = raw as Rpc
      if (message.method === 'turn/completed') completed = true
      if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') commands.push(message.params.item)
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }, error => { for (const waiter of pending.values()) waiter.reject(error) })
    const call = (method: string, params: Rpc): Promise<Rpc> => new Promise((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); transport!.send({ id, method, params })
    })
    await call('initialize', { clientInfo: { name: 'native-cache-fixture', version: '1' }, capabilities: { experimentalApi: true } })
    transport.send({ method: 'initialized' })
    const thread = await call('thread/start', { cwd, model: 'gpt-5.5', modelProvider: 'fixture', approvalPolicy: 'never', sandbox: 'workspace-write', ephemeral: true })
    await call('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Run the two fixture installs' }] })
    const deadline = Date.now() + 30_000
    while (!completed && Date.now() < deadline) await Bun.sleep(25)
    assert(completed, 'native turn must complete')
    assert.equal(commands.length, 2, 'both real native commands must complete')
    for (const command of commands) {
      assert.equal(command.exitCode, 0, 'each direct install/runtime/compiler command must pass')
      assert(command.aggregatedOutput.includes('TS2322'), 'each invalid TypeScript sibling must fail')
      assert(command.aggregatedOutput.includes('1 pass'), 'each real peer dependency test must pass')
    }
    assert(outputs.at(-1)!.includes(cache), 'real direct native shell must inherit prepared cache')
    assert(outputs.at(-1)!.includes('TS2322'), 'invalid TypeScript must actually fail')
    assert(outputs.at(-1)!.includes('1 pass'), 'real peer dependency test must pass')
    const original = lstatSync(join(cache, 'typescript@5.9.3@@@1', 'lib', 'typescript.js'))
    const inodes = [[original.dev, original.ino]]
    for (const path of worktrees) {
      const installed = lstatSync(join(path, 'node_modules', 'typescript', 'lib', 'typescript.js'))
      assert.deepEqual([installed.dev, installed.ino], [original.dev, original.ino], 'install must hardlink rather than copy')
      inodes.push([installed.dev, installed.ino])
    }
    // Remove only the generated fixture cache; installed hardlinks must remain.
    rmSync(cache, { recursive: true })
    for (const path of worktrees) {
      const runtime = Bun.spawnSync(['bun', 'test', 'runtime.test.ts'], { cwd: path })
      assert.equal(runtime.exitCode, 0, 'cache retirement must preserve installed runtime')
      const valid = Bun.spawnSync(['bunx', '--no-install', 'tsc', '--noEmit', '--target', 'ES2022', '--lib', 'es2022', 'valid.ts'], { cwd: path })
      assert.equal(valid.exitCode, 0, 'cache retirement must preserve installed compiler')
    }
    console.log('PASS: production transport, direct native installs, inode sharing, runtime peers, TypeScript siblings and retired cache', JSON.stringify({ inodes }))
  } finally {
    transport?.close(); provider.stop(true)
    rmSync(root, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true })
  }
}
await main()
