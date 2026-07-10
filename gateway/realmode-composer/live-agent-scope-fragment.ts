/**
 * @neutronai/gateway — the live-agent `<live_agent_context>` SCOPE fragment.
 *
 * Extracted from `composeFirstTurnPrompt` (build-live-agent-turn.ts) as a pure
 * function so the per-scope prompt text — including the RA5 memory-recall hint —
 * is unit-testable in isolation (mirrors `operating-doctrine.ts`).
 *
 * Two scopes:
 *   - `general` — the cross-project assistant surface. Carries the RECALL
 *     steering: read the on-disk workspace AND use the backend-neutral
 *     `memory_search` tool for long-term entity/fact recall (RA5 §(a) — the
 *     tool rename must also surface the tool in the prompt, closing the
 *     "memory tool never mentioned, agent greps files instead" gap the m1-e2e
 *     QA flagged). Backend-neutral by construction: names the TOOL, not GBrain.
 *   - `project` — scoped to one project's files + the tappable doc-link marker,
 *     PLUS the same backend-neutral `memory_search` recall hint (project turns
 *     use long-term entity/fact recall too).
 */
export type LiveAgentScope =
  | { scope: 'general' }
  | { scope: 'project'; project_id: string }

export function buildLiveAgentScopeFragment(input: LiveAgentScope): string {
  if (input.scope === 'project') {
    const projectId = input.project_id
    return [
      '<live_agent_context>',
      `You are chatting with the user inside the "${projectId}" project topic.`,
      'Scope your answers to this project unless the user clearly asks wider.',
      `Project files (when materialized) live under Projects/${projectId}/ in your working directory.`,
      // RA5 memory-recall hint — project turns also use long-term entity/fact
      // recall, so surface the backend-neutral recall tool here too.
      'To recall what you already know about a person, company, project, or fact before asking the user,',
      'use the memory_search tool — it searches your long-term memory (the entities/facts the scribe recorded),',
      'distinct from doc_search (project files) and message_search (chat history).',
      // Doc references: announce any doc you draft or edit as a TAPPABLE link,
      // never a raw filesystem path. The client linkifies this exact marker and
      // opens it in the Documents tab (runtime/doc-links.ts rewriteDocRefsInBody).
      'When you tell the user about a doc you drafted or edited, reference it as a tappable link',
      `using the exact marker [friendly-name](docs:/${projectId}/<path>), where friendly-name is`,
      "the filename without its .md extension and <path> is the doc's path relative to the project's",
      `docs/ folder — e.g. Projects/${projectId}/docs/brief.md → [brief](docs:/${projectId}/brief.md),`,
      `and the project's STATUS.md → [STATUS](docs:/${projectId}/STATUS.md).`,
      'Never announce a raw Projects/… filesystem path; always use the docs:/ marker so the reference opens in the Documents tab.',
      'This is a live chat turn: answer the user directly and concisely.',
      '</live_agent_context>',
    ].join('\n')
  }
  return [
    '<live_agent_context>',
    'You are chatting with the user in their General topic — the cross-project assistant surface.',
    'Their workspace (persona/, entities/, Projects/) is your working directory; read from it when recall helps.',
    // RA5 memory-recall hint — surface the backend-neutral recall tool so the
    // agent uses it instead of only grepping the filesystem.
    'To recall what you already know about a person, company, project, or fact before asking the user,',
    'use the memory_search tool — it searches your long-term memory (the entities/facts the scribe recorded),',
    'distinct from doc_search (project files) and message_search (chat history).',
    // Doc references: same tappable-link convention, with the project id spelled out per doc.
    'When you tell the user about a doc in a project, reference it as a tappable link using the exact',
    "marker [friendly-name](docs:/<project_id>/<path>), where friendly-name is the filename without its",
    ".md extension and <path> is relative to that project's docs/ folder — e.g. [brief](docs:/<project_id>/brief.md).",
    'Never announce a raw Projects/… filesystem path; always use the docs:/ marker so it opens in the Documents tab.',
    'This is a live chat turn: answer the user directly and concisely.',
    '</live_agent_context>',
  ].join('\n')
}
