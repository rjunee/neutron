/**
 * @neutronai/onboarding/api — POST /onboarding/start (P2 S2).
 *
 * Per docs/plans/P2-onboarding.md § 6 S2 line 1947. Initial seam for the
 * post-signin trigger to begin the interview programmatically. Boots the
 * `onboarding_state` row at phase=`signup` and emits the first prompt.
 *
 * Production callers route this through `signup/post-signin-router.ts`
 * after the Managed post-signin provisioning lands; the router already redirects the user
 * to either the Telegram deep-link or the web chat — once the user
 * sends their first inbound, this endpoint kicks the engine.
 */

import type { InterviewEngine } from '../interview/engine.ts'

export interface StartOnboardingRequest {
  project_slug: string
  topic_id: string
  user_id: string
  signup_via: 'telegram' | 'web'
}

export type StartOnboardingStatus = 'started' | 'already_in_progress' | 'error'

export interface StartOnboardingResponse {
  status: StartOnboardingStatus
  prompt_id?: string
  reason?: string
}

export async function handleStartOnboarding(
  engine: InterviewEngine,
  req: StartOnboardingRequest,
): Promise<StartOnboardingResponse> {
  try {
    const result = await engine.start({
      project_slug: req.project_slug,
      topic_id: req.topic_id,
      user_id: req.user_id,
      signup_via: req.signup_via,
    })
    if (result.was_new) {
      return { status: 'started', prompt_id: result.prompt_id }
    }
    return { status: 'already_in_progress', prompt_id: result.prompt_id }
  } catch (err) {
    return {
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
