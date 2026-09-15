import { modelTier } from './model-tiers.ts'
import type { KimiReviewResult } from './kimi-review.ts'

/** A configured seat uses the OpenAI chat-completions wire protocol.
 * Resolve the row and credential at invocation; never retry with a different model.
 * All refusals join the existing blocking `deferred` status vocabulary.
 */
export async function reviewConfiguredSeat(
  tier: string,
  diff: string,
  task: string,
  fetchImpl: (input: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<KimiReviewResult> {
  const seat = modelTier(tier)
  const name = seat?.model_id ?? tier
  const refuse = (reason: string): KimiReviewResult => ({
    status: 'deferred', text: '', reason: `review seat ${name}: ${reason}`,
  })
  if (!seat?.endpoint || !seat.credential || seat.group !== 'api') return refuse('unknown configured model')
  const key = process.env[seat.credential]
  if (!key?.trim()) return refuse(`missing credential ${seat.credential}`)
  if (!diff.trim()) return refuse('empty diff')
  try {
    const response = await fetchImpl(seat.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: seat.model_id, max_tokens: 20_000, messages: [
        { role: 'system', content: 'You are an independent code reviewer. Evidence-gate findings with file:line. End with VERDICT: APPROVE or VERDICT: REQUEST_CHANGES.' },
        { role: 'user', content: `TASK: ${task}\nUnified diff:\n${diff}` },
      ] }),
      signal: AbortSignal.timeout(480_000),
      redirect: 'error',
    })
    if (!response.ok) return refuse(`HTTP ${response.status}`)
    const body = await response.json() as { model?: string; choices?: Array<{ message?: { content?: unknown } }> }
    if (body.model !== seat.model_id) return refuse('response model does not match requested model')
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) return refuse('empty answer')
    return { status: 'connected', text: content }
  } catch {
    // Provider bodies and exception messages may contain credentials; report only the operation.
    return refuse('request failed or response was invalid')
  }
}
