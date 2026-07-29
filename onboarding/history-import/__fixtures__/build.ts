/**
 * Build the synthetic ChatGPT / Claude.ai zip test fixtures.
 *
 * Run: `bun run onboarding/history-import/__fixtures__/build.ts`
 *
 * Per docs/plans/P2-onboarding.md § 6 S3 fixture list:
 *   - synthetic-small-chatgpt.zip       — ~5 conversations, ~50KB
 *   - synthetic-medium-chatgpt.zip      — ~50 conversations, ~5MB
 *   - synthetic-claude-export.zip       — Claude.ai shape
 *   - synthetic-50M-token.zip           — wide-shape fixture for the
 *     50M-token integration test (NOT 50M actual tokens; mocked LLM
 *     cost reporter returning $0.10/chunk hits the 80%/100% gates).
 *
 * Fully synthetic — every person / company / project name below is
 * fictional (no real owner, customer, or vendor data). This file ships
 * to the public Open tree, so it carries ZERO real-world identifiers
 * (the leak-gate scans it). The shapes here mimic real exports (mapping
 * graphs for ChatGPT, chat_messages arrays for Claude) so the parser
 * exercises real code paths. Counts are tuned to satisfy the
 * integration-test assertions (>= 5 projects / 10 tasks / 5 reminders /
 * 20 entities) without bloating the repo.
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeZip } from '@neutronai/onboarding/history-import/__tests__/zip-writer.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

interface ChatGptNode {
  id: string
  message: {
    id: string
    author: { role: string }
    content: { content_type: string; parts: string[] }
    create_time: number
    metadata: Record<string, unknown>
  } | null
  parent: string | null
  children: string[]
}

interface ChatGptConversation {
  id: string
  title: string
  create_time: number
  current_node: string
  mapping: Record<string, ChatGptNode>
}

// Fictional people + companies — NO real-world names (leak-gate scanned).
const ENTITIES = [
  'Dana',
  'Marco',
  'Priya',
  'Lena',
  'Acme Corp',
  'Northwind',
  'Globex',
  'Initech',
  'Vandelay',
  'Umbrella Co',
  'Soylent',
  'Hooli',
  'Wonka Labs',
  'Stark Industries',
  'Sofia',
  'Omar',
  'Nadia',
  'Kenji',
  'Ravi',
  'Elena',
  'Tomas',
  'Hana',
  'Marcus',
  'Aiden',
  'Bianca',
]

const TOPICS = [
  'Sales pipeline review',
  'Platform rewrite',
  'Service architecture',
  'Cloud migration',
  'Onboarding flow',
  'Training course',
  'Product launch',
  'Brand refresh',
  'Mobile app',
  'Inference engine',
]

const TASK_HINTS = [
  'Reply to Marco about the Q3 invoice',
  'Review the partner proposal',
  'Schedule the product photoshoot',
  'Renew the hosting contract',
  'Deploy platform v2',
  'Onboard Dana to the workspace',
  'Prepare Q3 board materials',
  'Sync with Priya about the offsite',
  'Draft the brand brief',
  'Wire the mobile build',
  'Audit the packaging design',
  'Spec the async API',
  'Document the runtime',
  'Back up the service state',
  'Test the chat /start handler',
]

function buildSyntheticChatgptConversation(seed: number, msgCount: number): ChatGptConversation {
  const id = `synthetic-conv-${seed.toString().padStart(4, '0')}`
  const mapping: Record<string, ChatGptNode> = {}
  let parent: string | null = null
  const baseTime = 1714521600 + seed * 3600
  let lastNode = ''
  for (let i = 0; i < msgCount; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const nodeId = `${id}-${i}`
    const entity = ENTITIES[(seed + i) % ENTITIES.length]
    const topic = TOPICS[(seed + i) % TOPICS.length]
    const taskHint = i % 5 === 0 && role === 'user'
      ? TASK_HINTS[(seed + i) % TASK_HINTS.length]
      : undefined
    const text =
      role === 'user'
        ? buildUserText(entity, topic, taskHint)
        : buildAssistantText(entity, topic)
    mapping[nodeId] = {
      id: nodeId,
      message: {
        id: nodeId,
        author: { role },
        content: { content_type: 'text', parts: [text] },
        create_time: baseTime + i * 60,
        metadata: {},
      },
      parent,
      children: [],
    }
    if (parent !== null && mapping[parent] !== undefined) {
      mapping[parent]!.children.push(nodeId)
    }
    parent = nodeId
    lastNode = nodeId
  }
  return {
    id,
    title: `Synthetic conversation ${seed} about ${TOPICS[seed % TOPICS.length]}`,
    create_time: baseTime,
    current_node: lastNode,
    mapping,
  }
}

function buildUserText(entity: string | undefined, topic: string | undefined, taskHint?: string): string {
  const parts = [`Need to think about ${topic ?? 'general roadmap'}.`]
  if (entity !== undefined) parts.push(`${entity} is involved here.`)
  if (taskHint !== undefined) parts.push(`Action item: ${taskHint}.`)
  parts.push(`We should decide by next week. ${entity ?? 'Team'} owns the call.`)
  return parts.join(' ')
}

function buildAssistantText(entity: string | undefined, topic: string | undefined): string {
  return `Got it. For ${topic ?? 'this topic'}, the next step is to confirm with ${
    entity ?? 'the team'
  } what the deadline is. ${entity ?? 'They'} will need a clear ask.`
}

function buildSmallChatgpt(): Buffer {
  const convos = [
    buildSyntheticChatgptConversation(1, 8),
    buildSyntheticChatgptConversation(2, 12),
    buildSyntheticChatgptConversation(3, 6),
    buildSyntheticChatgptConversation(4, 10),
    buildSyntheticChatgptConversation(5, 14),
  ]
  return writeZip([
    { name: 'conversations.json', data: Buffer.from(JSON.stringify(convos), 'utf8') },
  ])
}

function buildMediumChatgpt(): Buffer {
  const convos: ChatGptConversation[] = []
  for (let i = 1; i <= 50; i++) {
    convos.push(buildSyntheticChatgptConversation(i, 30 + (i % 10)))
  }
  return writeZip([
    { name: 'conversations.json', data: Buffer.from(JSON.stringify(convos), 'utf8') },
  ])
}

function build50MTokenShape(): Buffer {
  // Wide shape: many short conversations to maximize chunk count for
  // the budget cap test. The chunker yields one chunk per conversation
  // (since each conversation fits under target_tokens). At 80 chunks
  // and a mocked $0.10/chunk reporter, we hit $3.50 cap at chunk 35
  // (35*0.10 = 3.50 -> ok=false on chunk 36). Test asserts the cap
  // logic precisely.
  const convos: ChatGptConversation[] = []
  for (let i = 1; i <= 80; i++) {
    convos.push(buildSyntheticChatgptConversation(i, 20))
  }
  return writeZip([
    { name: 'conversations.json', data: Buffer.from(JSON.stringify(convos), 'utf8') },
  ])
}

function buildClaudeExport(): Buffer {
  const convos: Array<Record<string, unknown>> = []
  for (let s = 1; s <= 8; s++) {
    const baseTime = 1714521600 + s * 3600
    const messages: Array<Record<string, unknown>> = []
    for (let i = 0; i < 12; i++) {
      const sender = i % 2 === 0 ? 'human' : 'assistant'
      const entity = ENTITIES[(s + i) % ENTITIES.length]
      const topic = TOPICS[(s + i) % TOPICS.length]
      const text =
        sender === 'human'
          ? buildUserText(entity, topic, i % 4 === 0 ? TASK_HINTS[(s + i) % TASK_HINTS.length] : undefined)
          : buildAssistantText(entity, topic)
      messages.push({
        uuid: `claude-${s}-${i}`,
        sender,
        text,
        created_at: new Date((baseTime + i * 60) * 1000).toISOString(),
      })
    }
    convos.push({
      uuid: `claude-conv-${s}`,
      name: `Claude conversation ${s} about ${TOPICS[s % TOPICS.length]}`,
      created_at: new Date(baseTime * 1000).toISOString(),
      chat_messages: messages,
    })
  }
  return writeZip([
    { name: 'conversations.json', data: Buffer.from(JSON.stringify(convos), 'utf8') },
  ])
}

// ─────────────────────────────────────────────────────────────────────
// T12 — founder-shape walkthrough fixture for the E2E harness.
//
// scripts/e2e/fixtures/synthetic-chatgpt-export.zip is the ChatGPT
// export the m2-walkthrough harness uploads to <project_home>/imports/
// chatgpt.zip on the prod box at the import_offered phase. It MUST yield
// a meaningful Pass-1 + Pass-2 result — the spec'd flow asserts the
// engine reaches archetype_picked with real upstream context (entities,
// topics, proposed projects) instead of an empty ImportResult.
//
// Fully synthetic conversations — NO real-world data. The persona is a
// fictional consumer-brand founder (warm-strategist tone, planning-heavy
// topics) tuned so Pass-2 emits ≥ 2 proposed projects + ≥ 5 voice
// signals → triggers the wow-dispatch actions that gate on a non-empty
// ImportResult.
// ─────────────────────────────────────────────────────────────────────

const FOUNDER_TOPICS = [
  'launching the new wellness product line',
  'sourcing packaging from an overseas supplier',
  'planning the Q4 photoshoot',
  'reviewing supplier MOQ negotiations',
  'drafting the brand voice guide',
  'mapping the customer journey',
  'building the founder operating cadence',
  'hiring the first ops manager',
  'spec-ing the analytics dashboard',
  'preparing the investor update',
]

const FOUNDER_PEOPLE = [
  'Marco',
  'the founder',
  'Priya',
  'Dana',
  'Omar',
  'Nadia',
  'the overseas supplier',
  'the brand consultant',
]

const FOUNDER_TASKS = [
  'finalize the box dieline this week',
  'reply to the supplier on MOQ revisions',
  'draft the Q4 brand-voice doc by Friday',
  'schedule the product shoot for next month',
  'review the analytics dashboard wireframe',
  'follow up with the founder on the ops-hire shortlist',
  'send the investor update before month-end',
  'prepare the supplier comparison for the team',
]

function buildFounderConversation(seed: number): ChatGptConversation {
  // Each conversation is a planning-heavy exchange between a founder-shape
  // user (warm collaborator + strategist) and ChatGPT. The mix of tone +
  // topic + people + recurring task hints gives Pass-2 a meaningful
  // personality vector AND ≥ 2 proposed projects.
  const topic = FOUNDER_TOPICS[seed % FOUNDER_TOPICS.length]!
  const id = `founder-walkthrough-${seed.toString().padStart(3, '0')}`
  const mapping: Record<string, ChatGptNode> = {}
  let parent: string | null = null
  const baseTime = 1714521600 + seed * 4_500
  let lastNode = ''
  // 8-12 turns per conversation — enough for Pass-1 to extract entities
  // + tasks + recurring topics; cheap enough to keep the zip < 100 KB.
  const turns = 8 + (seed % 5)
  for (let i = 0; i < turns; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant'
    const nodeId = `${id}-${i}`
    const person = FOUNDER_PEOPLE[(seed + i) % FOUNDER_PEOPLE.length]!
    const taskHint =
      role === 'user' && i % 3 === 0
        ? FOUNDER_TASKS[(seed + i) % FOUNDER_TASKS.length]
        : undefined
    const text =
      role === 'user'
        ? buildFounderUserText(topic, person, taskHint)
        : buildFounderAssistantText(topic, person)
    mapping[nodeId] = {
      id: nodeId,
      message: {
        id: nodeId,
        author: { role },
        content: { content_type: 'text', parts: [text] },
        create_time: baseTime + i * 90,
        metadata: {},
      },
      parent,
      children: [],
    }
    if (parent !== null && mapping[parent] !== undefined) {
      mapping[parent]!.children.push(nodeId)
    }
    parent = nodeId
    lastNode = nodeId
  }
  return {
    id,
    title: `Working on ${topic}`,
    create_time: baseTime,
    current_node: lastNode,
    mapping,
  }
}

function buildFounderUserText(topic: string, person: string, taskHint?: string): string {
  // Founder-shape voice: warm collaborator + strategist. Bullet-style
  // thinking, asks for "what would you do" rather than yes/no questions,
  // mentions specific people + dates. Pass-1 picks up "warm" + "ask-
  // open" + "structured-bullet" voice signals; Pass-2 flags this as a
  // strategist who values clear next-actions.
  const parts = [
    `I'm working on ${topic} and want to think it through with you.`,
    `${person} is involved on the other side and we have some friction on next steps.`,
    `Help me sketch out a plan: what are the 2-3 things I should be deciding right now versus what can wait?`,
  ]
  if (taskHint !== undefined) {
    parts.push(`Action item to capture: ${taskHint}.`)
  }
  parts.push(`What would you do if you were in my seat?`)
  return parts.join(' ')
}

function buildFounderAssistantText(topic: string, person: string): string {
  return [
    `Here is how I'd think about ${topic} in 3 steps:`,
    `1. Clarify the constraint with ${person} so you both agree on the bottleneck.`,
    `2. Ship the smallest decision today that lets you move tomorrow.`,
    `3. Keep one strategic question open for the weekly review.`,
    `Does that framing match what you were holding?`,
  ].join(' ')
}

function buildFounderWalkthroughChatgpt(): Buffer {
  // 10 conversations across the topic catalogue → Pass-2 will see
  // recurring entities (the founder, Marco, the overseas supplier) +
  // recurring topics (the wellness line, packaging) → proposes ≥ 3
  // projects.
  const convos: ChatGptConversation[] = []
  for (let i = 1; i <= 10; i++) {
    convos.push(buildFounderConversation(i))
  }
  return writeZip([
    { name: 'conversations.json', data: Buffer.from(JSON.stringify(convos), 'utf8') },
  ])
}

function main(): void {
  const fixtures: Array<{ name: string; bytes: Buffer; out_path: string }> = [
    {
      name: 'synthetic-small-chatgpt.zip',
      bytes: buildSmallChatgpt(),
      out_path: join(HERE, 'synthetic-small-chatgpt.zip'),
    },
    {
      name: 'synthetic-medium-chatgpt.zip',
      bytes: buildMediumChatgpt(),
      out_path: join(HERE, 'synthetic-medium-chatgpt.zip'),
    },
    {
      name: 'synthetic-50M-token.zip',
      bytes: build50MTokenShape(),
      out_path: join(HERE, 'synthetic-50M-token.zip'),
    },
    {
      name: 'synthetic-claude-export.zip',
      bytes: buildClaudeExport(),
      out_path: join(HERE, 'synthetic-claude-export.zip'),
    },
    {
      // T12 — founder-shape walkthrough fixture. Lives under
      // scripts/e2e/fixtures so it ships with the harness, not the
      // unit-test fixture set. Per spec: < 100 KB, fully synthetic.
      name: 'synthetic-chatgpt-export.zip',
      bytes: buildFounderWalkthroughChatgpt(),
      out_path: join(HERE, '..', '..', '..', 'scripts', 'e2e', 'fixtures', 'synthetic-chatgpt-export.zip'),
    },
  ]
  for (const f of fixtures) {
    writeFileSync(f.out_path, f.bytes)
    console.log(`wrote ${f.out_path} (${f.bytes.length} bytes)`)
  }
}

main()
