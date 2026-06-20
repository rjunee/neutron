/**
 * Build the Mira-shape synthetic ChatGPT export zip fixture (P2 S6).
 *
 * Run: `bun run tests/fixtures/m2/build.ts`
 *
 * Per docs/plans/P2-onboarding.md § 6 S6 line 2198. The Mira-shape
 * fixture represents 6-months of fragrance-launch + childcare
 * conversations and is consumed by `tests/integration/m2-mira-fixture.test.ts`.
 *
 * Synthetic-only — explicitly marked as such in the PR body. The shape
 * exercises the import pipeline (5-10 conversations, ~50KB compressed).
 * Mocked LLM cost reporters return deterministic dollar amounts so the
 * shape doesn't need to be production-scale.
 *
 * Cohort signals woven into the conversations:
 *   - 2 stalled email threads (Dana Reyes, Omar) referenced
 *   - 3 proposed projects (Caldera, Ledgerline, Childcare logistics)
 *   - overdue tasks, captured rituals, contemplative keywords
 *   - voice signals (expansive, mid-verbosity, mixed structure)
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

interface MiraTurn {
  role: 'user' | 'assistant'
  text: string
}

interface MiraConversation {
  title: string
  base_time: number
  turns: MiraTurn[]
}

const SIX_MONTHS_AGO = 1714521600 // 2024-05 baseline; per § 6 S6 fixture spec (synthetic)

const MIRA_CONVERSATIONS: MiraConversation[] = [
  {
    title: 'Caldera brand brief — Q3 launch',
    base_time: SIX_MONTHS_AGO,
    turns: [
      { role: 'user', text:
        'I need to think through the Q3 fragrance launch. The Halo line is going to be the anchor — we have to nail the brand brief before Dana Reyes finalizes the photoshoot. I keep losing track of the email thread with Dana; she sent a proposal three weeks ago and I still have not replied.' },
      { role: 'assistant', text:
        'That matters. The Dana Reyes thread is a stalled outbound: she replied, you have not. Caldera is the project; Halo is the launch SKU. Action item: reply to Dana with the brand brief by end of week.' },
      { role: 'user', text:
        'Yes — Caldera is the parent project. Honestly I am exhausted from the morning meditation routine slipping. With childcare logistics on top of Ledgerline and the Cores work, I am spread thin.' },
      { role: 'assistant', text:
        'You mentioned morning meditation as a ritual — that is captured. We can wire a 6:30am reminder. Childcare logistics keeps surfacing as its own project distinct from Caldera and Ledgerline.' },
      { role: 'user', text:
        'Right. Childcare logistics is a real project. Rosa helps but I still own the calendar. The pediatrician follow-up is overdue — I should have scheduled it last week.' },
      { role: 'assistant', text:
        'Captured. Overdue task: Schedule pediatrician follow-up. Childcare logistics is now a separate project from Caldera.' },
    ],
  },
  {
    title: 'Ledgerline Q3 invoice — Omar follow-up',
    base_time: SIX_MONTHS_AGO + 7 * 24 * 3600,
    turns: [
      { role: 'user', text:
        'Omar emailed me about the Ledgerline Q3 invoice — I have not replied in two weeks. I need to get him an answer about the JV terms with Cole. Ledgerline is consuming a lot of my mental cycles.' },
      { role: 'assistant', text:
        'Stalled email thread: Omar / Q3 invoice / Ledgerline. This is a high-leverage outbound. Action item: draft a reply to Omar about Q3 invoice today.' },
      { role: 'user', text:
        'Yes. And separately I have been doing morning meditation for 20 minutes most days — it is a ritual that grounds me. The Sunday review keeps me oriented for the week ahead.' },
      { role: 'assistant', text:
        'Two rituals captured: morning meditation (20m, ~6:30) and Sunday review. Both worth a recurring nudge.' },
    ],
  },
  {
    title: 'Mindfulness / contemplative practice in business decisions',
    base_time: SIX_MONTHS_AGO + 30 * 24 * 3600,
    turns: [
      { role: 'user', text:
        'I want to bring more mindfulness into how I think about Caldera. The stress of Halo launch is making me reactive. Meditation helps but I want a contemplative frame for the work itself.' },
      { role: 'assistant', text:
        'Contemplative tradition keywords here: meditation, mindfulness. The thread between practice and product decisions is non-trivial.' },
      { role: 'user', text:
        'Right. The dharma of being a founder. I keep coming back to the idea that the work itself is the practice — not separate from it.' },
      { role: 'assistant', text:
        'Captured in voice signals: expansive tone, contemplative framing, mixed structure (story + decisions). Useful for the persona generator.' },
    ],
  },
  {
    title: 'Childcare logistics — Rosa scheduling',
    base_time: SIX_MONTHS_AGO + 60 * 24 * 3600,
    turns: [
      { role: 'user', text:
        'Rosa needs the school calendar for Lily for the next term. I keep forgetting to send it. The pediatrician follow-up for Ivy is also overdue. This is a real project — not just one-off tasks.' },
      { role: 'assistant', text:
        'Childcare logistics confirmed as a project. Two overdue tasks here: send school calendar to Rosa, schedule pediatrician follow-up.' },
      { role: 'user', text:
        'Sunday review is when I usually catch up on these. It works when I do not skip it.' },
      { role: 'assistant', text:
        'Sunday review ritual reaffirmed. Time-of-day implied: late afternoon (5pm-ish) based on prior context.' },
    ],
  },
  {
    title: 'Halo packaging audit — Dana Reyes thread',
    base_time: SIX_MONTHS_AGO + 90 * 24 * 3600,
    turns: [
      { role: 'user', text:
        'Dana Reyes proposed a packaging audit two weeks ago. The thread is still open. Halo is the launch SKU under Caldera. I have to reply but I want to think through the cost first.' },
      { role: 'assistant', text:
        'Dana Reyes stalled thread re-surfaces. Same action item as before: reply to Dana about the packaging audit.' },
      { role: 'user', text:
        'And Omar is still waiting on the Q3 invoice answer. I am behind on outbound communications. Morning meditation has been slipping too. The launch stress is real.' },
      { role: 'assistant', text:
        'Two stalled threads (Dana, Omar) carrying high stakes. Ritual slippage noted. Action items: 1) reply to Dana re: packaging audit, 2) reply to Omar re: Q3 invoice, 3) re-anchor morning meditation at 6:30.' },
    ],
  },
  {
    title: 'Neutron architecture musings',
    base_time: SIX_MONTHS_AGO + 120 * 24 * 3600,
    turns: [
      { role: 'user', text:
        'Alex keeps mentioning Neutron and Sidekick rewrites. I do not understand the technical layer but I want Neutron to actually help me with the ops side. Project shells, reminders, and a brief that actually catches what I missed last week.' },
      { role: 'assistant', text:
        'Use cases captured: project shells (Caldera, Ledgerline, Childcare logistics, Halo), recurring reminders for rituals, weekly brief for catch-up.' },
    ],
  },
  {
    title: 'Sunday review — week of Caldera + Ledgerline + family',
    base_time: SIX_MONTHS_AGO + 150 * 24 * 3600,
    turns: [
      { role: 'user', text:
        'Sunday review. Dana still pending. Omar still pending. School calendar still not sent. Pediatrician still not scheduled. Meditation 4 of 7 mornings this week. Sunday review on time. Evening family dinner held nightly.' },
      { role: 'assistant', text:
        'Three rituals captured cleanly: morning meditation (06:30), evening family dinner (19:00), weekly Sunday review (17:00). Two overdue tasks remain. Two stalled threads.' },
    ],
  },
]

function buildMiraConversation(seed: MiraConversation, idx: number): ChatGptConversation {
  const id = `mira-conv-${(idx + 1).toString().padStart(2, '0')}`
  const mapping: Record<string, ChatGptNode> = {}
  let parent: string | null = null
  let lastNode = ''
  for (let i = 0; i < seed.turns.length; i++) {
    const t = seed.turns[i]
    if (t === undefined) continue
    const nodeId = `${id}-${i}`
    mapping[nodeId] = {
      id: nodeId,
      message: {
        id: nodeId,
        author: { role: t.role },
        content: { content_type: 'text', parts: [t.text] },
        create_time: seed.base_time + i * 60,
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
    title: seed.title,
    create_time: seed.base_time,
    current_node: lastNode,
    mapping,
  }
}

function buildMiraShapeChatgpt(): Buffer {
  const convos = MIRA_CONVERSATIONS.map(buildMiraConversation)
  return writeZip([
    { name: 'conversations.json', data: Buffer.from(JSON.stringify(convos), 'utf8') },
  ])
}

function main(): void {
  const out = join(HERE, 'mira-synthetic-chatgpt-export.zip')
  const bytes = buildMiraShapeChatgpt()
  writeFileSync(out, bytes)
  console.log(`wrote ${out} (${bytes.length} bytes; ${MIRA_CONVERSATIONS.length} conversations)`)
}

main()
