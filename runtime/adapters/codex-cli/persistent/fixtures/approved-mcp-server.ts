import { appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema, CompleteRequestSchema, GetPromptRequestSchema,
  ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema, ReadResourceRequestSchema, SubscribeRequestSchema, UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// A real local SDK peer, never an owner-installed server or a build harness.
function record(value: string): void {
  if (process.env.BROKER_TEST_LOG) appendFileSync(process.env.BROKER_TEST_LOG, `${value}\n`)
}
record('spawn')
if (process.env.BROKER_TEST_LOG) appendFileSync(`${process.env.BROKER_TEST_LOG}.pid`, `${process.pid}\n`)
const server = new Server({ name: 'broker-fixture', version: '1.0.0' }, {
  capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true },
    prompts: { listChanged: true }, completions: {} },
})
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'inspect',
  description: 'Report fixture arguments and declared environment', inputSchema: { type: 'object' } }] }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  record(`call:${request.params.name}`)
  if (request.params.arguments?.exitAfter) setTimeout(() => process.exit(0), Number(request.params.arguments.exitAfter))
  if (request.params.arguments?.notifyAfter) {
    setTimeout(() => {
      server.notification({ method: 'notifications/tools/list_changed' })
        .then(() => record('notified')).catch(() => {})
    }, Number(request.params.arguments.notifyAfter))
  }
  if (request.params.arguments?.delay) await Bun.sleep(Number(request.params.arguments.delay))
  if (request.params.arguments?.progress && request.params._meta?.progressToken !== undefined) {
    await server.notification({ method: 'notifications/progress', params: {
      progressToken: request.params._meta.progressToken, progress: 1, total: 2, message: 'fixture progress',
    } })
    await Bun.sleep(20)
  }
  if (typeof request.params.arguments?.notifyUri === 'string') {
    await server.notification({ method: 'notifications/resources/updated', params: { uri: request.params.arguments.notifyUri } })
  }
  return { content: [{ type: 'text', text: JSON.stringify({ argv: process.argv.slice(2), env: process.env }) }] }
})
server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [{ uri: 'fixture://one', name: 'one' }] }))
server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [
  { uriTemplate: 'fixture://{name}', name: 'fixture' },
] }))
server.setRequestHandler(ReadResourceRequestSchema, (request) => ({ contents: [{ uri: request.params.uri, text: 'fixture text' }] }))
server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  record(`subscribe:${request.params.uri}`)
  if (process.env.BROKER_TEST_SUBSCRIBE_DELAY) await Bun.sleep(Number(process.env.BROKER_TEST_SUBSCRIBE_DELAY))
  await server.notification({ method: 'notifications/resources/updated', params: { uri: request.params.uri } })
  return {}
})
server.setRequestHandler(UnsubscribeRequestSchema, (request) => { record(`unsubscribe:${request.params.uri}`); return {} })
server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: [{ name: 'hello' }] }))
server.setRequestHandler(GetPromptRequestSchema, () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }] }))
server.setRequestHandler(CompleteRequestSchema, () => ({ completion: { values: ['one'], total: 1, hasMore: false } }))
if (process.env.BROKER_TEST_CONNECT_DELAY) await Bun.sleep(Number(process.env.BROKER_TEST_CONNECT_DELAY))
await server.connect(new StdioServerTransport())
