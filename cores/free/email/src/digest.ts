import type { GmailClient } from './contract.ts'
import type { EmailPipelineStore, EmailRow } from './pipeline/store.ts'

export type DigestPeriod = 'morning' | 'afternoon'

export interface DigestWindow {
  local_day: string
  period: DigestPeriod
}

/** Return the due owner-local window. The five-minute poller may enter at any minute after the boundary. */
export function digestWindow(now_ms: number, time_zone: string): DigestWindow | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: time_zone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now_ms))
  const value = (kind: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === kind)?.value ?? ''
  const hour = Number(value('hour'))
  const period: DigestPeriod | null = hour >= 15 ? 'afternoon' : hour >= 10 ? 'morning' : null
  if (period === null) return null
  return { local_day: `${value('year')}-${value('month')}-${value('day')}`, period }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function renderDigest(window: DigestWindow, rows: readonly EmailRow[], summaries: ReadonlyMap<string, string> = new Map()): { subject: string; body: string } {
  const grouped = new Map<string, EmailRow[]>()
  for (const row of rows) {
    const category = row.category?.trim() || 'Other'
    grouped.set(category, [...(grouped.get(category) ?? []), row])
  }
  const lines = [`Email brief — ${window.local_day} ${window.period}`, '', `${rows.length} new message${rows.length === 1 ? '' : 's'}.`]
  for (const [category, messages] of grouped) {
    lines.push('', category)
    for (const row of messages) {
      const link = `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(row.thread_id)}`
      lines.push(`- ${escapeHtml(row.subject)} — ${escapeHtml(row.sender)}`, `  ${escapeHtml(summaries.get(row.id) ?? row.snippet)}`, `  ${link}`)
    }
  }
  return { subject: `Neutron email brief — ${window.period}`, body: lines.join('\n') }
}

export async function deliverDueDigest(input: {
  gmail: GmailClient
  store: EmailPipelineStore
  now_ms: number
  time_zone: string
  enabled: boolean
  llm?: ((prompt: string) => Promise<string>) | null
}): Promise<'disabled' | 'not_due' | 'already_delivered' | 'no_recipient' | 'delivered'> {
  if (!input.enabled) return 'disabled'
  const window = digestWindow(input.now_ms, input.time_zone)
  if (window === null) return 'not_due'
  if (input.store.hasDeliveredBrief(window.local_day, window.period)) return 'already_delivered'
  const recipient = input.store.listAccountSettings().find((row) => row.enabled === 1 && row.account_email !== null)?.account_email
  if (recipient == null) return 'no_recipient'
  const rows = input.store.listUnbriefedEmails()
  const summaries = new Map<string, string>()
  if (input.llm != null && rows.length > 0) {
    try {
      const response = JSON.parse(await input.llm(`Summarize each email. Return only JSON array objects with id, subject, summary.\n${JSON.stringify(rows.map((r) => ({ id: r.id, subject: r.subject, text: r.body_text ?? r.snippet })))}`)) as unknown
      if (Array.isArray(response)) {
        for (const item of response) {
          if (typeof item !== 'object' || item === null) continue
          const candidate = item as Record<string, unknown>
          const row = rows.find((r) => r.id === candidate['id'])
          // Subject echo binds every summary to its source; drift or swapped identities fall back.
          if (row !== undefined && candidate['subject'] === row.subject && typeof candidate['summary'] === 'string') summaries.set(row.id, candidate['summary'])
        }
      }
    } catch { /* deterministic snippet fallback */ }
  }
  const rendered = renderDigest(window, rows, summaries)
  const brief_id = input.store.createBrief({ ...window, generated_at: input.now_ms, email_count: rows.length, data: rendered.body })
  await input.gmail.sendMessage({ to: [recipient], subject: rendered.subject, body: rendered.body })
  input.store.markBriefDelivered(brief_id, input.now_ms, rows)
  return 'delivered'
}
