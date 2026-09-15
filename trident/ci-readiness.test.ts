import { expect, test } from 'bun:test'
import { classifyCiRollup, confirmConfigurationError, type RequiredCheckConfiguration } from './ci-readiness.ts'

const head = 'a'.repeat(40)
const resolved = (value: Partial<RequiredCheckConfiguration> = {}): RequiredCheckConfiguration => ({
  kind: 'resolved', required: ['test'], appBound: [], produced: ['test'], ...value,
})
const check = (name = 'test', conclusion = 'SUCCESS') => ({ name, __typename: 'CheckRun', status: 'COMPLETED', conclusion })

test('G048 app-bound requirement rejects a classic status row', () => {
  expect(classifyCiRollup(head, 'MERGEABLE', [{ context: 'test', __typename: 'StatusContext', state: 'SUCCESS' }],
    resolved({ appBound: ['test'] }), 0, 600_000)).toEqual({ kind: 'absent' })
  expect(classifyCiRollup(head, 'MERGEABLE', [check()], resolved({ appBound: ['test'] }), 0, 600_000))
    .toMatchObject({ kind: 'completed', conclusion: 'success' })
})

test('G050 configuration fault requires grace, base evidence, and a settled nonempty rollup', () => {
  const missing = resolved({ required: ['required'], produced: ['other'] })
  expect(classifyCiRollup(head, 'MERGEABLE', [check('other')], missing, 599_999, 600_000)).toEqual({ kind: 'absent' })
  expect(classifyCiRollup(head, 'MERGEABLE', [], missing, 600_000, 600_000)).toEqual({ kind: 'absent' })
  expect(classifyCiRollup(head, 'MERGEABLE', [check('other')], resolved({ required: ['required'], produced: [] }), 600_000, 600_000)).toEqual({ kind: 'absent' })
  expect(classifyCiRollup(head, 'MERGEABLE', [check('other')], missing, 600_000, 600_000))
    .toMatchObject({ kind: 'configuration-error' })
})

test('G046 unreadable producer evidence disables configuration-fault inference', () => {
  expect(classifyCiRollup(head, 'MERGEABLE', [check('other')], resolved({ required: ['required'], produced: null }),
    600_000, 600_000)).toEqual({ kind: 'absent' })
})

test('G051 fresh resolved configuration reclassifies a tentative fault', () => {
  const first = classifyCiRollup(head, 'MERGEABLE', [check('other')], resolved({ required: ['required'], produced: ['other'] }), 600_000, 600_000)
  const fresh = resolved({ required: ['other'], produced: ['other'] })
  expect(confirmConfigurationError(first, fresh, config => classifyCiRollup(head, 'MERGEABLE', [check('other')], config, 600_000, 600_000)))
    .toMatchObject({ kind: 'completed', conclusion: 'success' })
})
