import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WebNativeOwnerControlClient, isRecord, ownerIdentity,
  type FetchImpl, type NativeOwnerAction, type NativeOwnerControlState, type NativeOwnerQuestion } from './native-owner-control-client.ts'

/** Scope-keyed by the consuming model control; late reads and writes cannot cross scopes. */
export function NativeOwnerControl({ projectId, origin, token, fetchImpl }: {
  projectId: string | null; origin: string; token: string; fetchImpl?: FetchImpl
}): React.JSX.Element {
  const client = useMemo(() => new WebNativeOwnerControlClient(origin, token, fetchImpl), [origin, token, fetchImpl])
  const [state, setState] = useState<NativeOwnerControlState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const reading = useRef<number | null>(null)
  const mounted = useRef(false)

  const refresh = useCallback(async () => {
    if (!mounted.current || inFlight.current || reading.current !== null) return
    const version = ++generation.current
    reading.current = version
    try {
      const next = await client.get(projectId)
      if (generation.current === version && mounted.current) setState(next)
    } catch (cause) {
      if (generation.current === version && mounted.current) {
        setState(null)
        setError(cause instanceof Error ? cause.message : 'Could not load Codex controls.')
      }
    } finally { if (reading.current === version) reading.current = null }
  }, [client, projectId])

  useEffect(() => {
    mounted.current = true
    inFlight.current = false
    reading.current = null
    setState(null); setError(null); setSending(false)
    void refresh()
    const timer = setInterval(() => { void refresh() }, 2_000)
    return () => { mounted.current = false; generation.current++; clearInterval(timer) }
  }, [refresh])

  async function act(action: NativeOwnerAction): Promise<void> {
    if (!state || inFlight.current || !mounted.current) return
    inFlight.current = true; setSending(true); setError(null)
    reading.current = null
    const version = ++generation.current
    try {
      const next = await client.act(state, action)
      if (generation.current === version && mounted.current) setState(next)
    } catch (cause) {
      if (generation.current !== version || !mounted.current) return
      setState(null)
      setError(cause instanceof Error ? cause.message : 'Could not send the Codex action.')
      // Never retry a write: an uncertain answer might already have reached Codex.
    } finally {
      if (generation.current === version && mounted.current) {
        inFlight.current = false; setSending(false)
        void refresh()
      }
    }
  }

  return <div aria-label="Codex controls">
    {error && <span role="alert">{error}</span>}
    {error && <button type="button" disabled={sending}
      onClick={() => { setError(null); void refresh() }}>Refresh Codex controls</button>}
    {state?.turnId && <button type="button" aria-label="Interrupt Codex turn" disabled={sending}
      onClick={() => { void act({ action: 'interrupt' }) }}>Interrupt Codex</button>}
    {state?.pending.map(question => <NativeQuestion key={`${JSON.stringify(ownerIdentity(state))}:${typeof question.requestId}:${question.requestId}`}
      question={question} sending={sending} reply={result => { void act({ action: 'reply', requestId: question.requestId, result }) }} />)}
  </div>
}

function NativeQuestion({ question, sending, reply }: {
  question: NativeOwnerQuestion; sending: boolean; reply(result: unknown): void
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(question.method)
  const questions = question.method === 'item/tool/requestUserInput' && Array.isArray(question.params.questions)
    ? question.params.questions.filter(isRecord) : []
  const supportedInput = questions.length > 0 && questions.every(q => typeof q.id === 'string' && q.id.length > 0 && typeof q.question === 'string')
  const decisions = ['accept', 'decline', 'cancel'].filter(decision =>
    !Array.isArray(question.params.availableDecisions) || question.params.availableDecisions.includes(decision))
  return <div>
    <p>Codex needs your answer</p>
    {[question.params.reason, question.params.command].filter((value): value is string => typeof value === 'string').map((value, index) =>
      <p key={index} style={{ overflowWrap: 'anywhere' }}>{value}</p>)}
    {approval && decisions.length > 0 ? decisions.map(decision => <button key={decision} type="button"
      disabled={sending} onClick={() => reply({ decision })}>
      {decision === 'accept' ? 'Allow once' : decision === 'decline' ? 'Decline' : 'Cancel'}
    </button>) : supportedInput ? <>
      {questions.map(q => <div key={String(q.id)}>
        <label>{String(q.question)}
          <input aria-label={String(q.question)} type={q.isSecret === true ? 'password' : 'text'} disabled={sending}
            value={answers[String(q.id)] ?? ''} style={{ width: '100%', boxSizing: 'border-box' }}
            onChange={event => setAnswers(previous => ({ ...previous, [String(q.id)]: event.target.value }))} />
        </label>
        {Array.isArray(q.options) && q.options.filter(isRecord).map((option, index) => typeof option.label === 'string' &&
          <button key={index} type="button" disabled={sending}
            onClick={() => setAnswers(previous => ({ ...previous, [String(q.id)]: String(option.label) }))}>
            {option.label}{typeof option.description === 'string' ? ` — ${option.description}` : ''}
          </button>)}
      </div>)}
      <button type="button" disabled={sending || questions.some(q => !answers[String(q.id)]?.trim())}
        onClick={() => reply({ answers: Object.fromEntries(questions.map(q => [String(q.id), { answers: [answers[String(q.id)]] }])) })}>
        Send answer
      </button>
    </> : <p>This question needs an answer in the Codex terminal.</p>}
  </div>
}
