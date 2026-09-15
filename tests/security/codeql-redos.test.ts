import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A separate process owns the deadline: a blocked regex cannot service an
// in-process timer. Each fixture also asserts ordinary accepted output.
const cases: Array<[string, string]> = [
  ['28 calendar verb', `
    import { parseCalCommand } from './cores/free/calendar/src/chat-commands.ts';
    assert.equal(parseCalCommand('/cal help', now).kind, 'help');
    assert.equal(parseCalCommand('/cal ' + 'x'.repeat(n) + '\\nX\\nY', now).kind, 'unrecognized');
  `],
  ...[
    ['30 tomorrow', 'tomorrow', 'tomorrow at noon'],
    ['31 next weekday', 'next monday', 'next monday at noon'],
    ['32 month day', 'on june 20', 'on june 20 at noon'],
  ].map(([label, prefix, normal]): [string, string] => [label!, `
    import { resolveTimeSpec } from './cores/free/reminders/src/chat-commands.ts';
    assert.equal(resolveTimeSpec(${JSON.stringify(normal)}, now)?.kind, 'ok');
    assert.equal(resolveTimeSpec(${JSON.stringify(prefix)} + ' '.repeat(n) + 'noon\\nX', now), null);
  `]),
  ['33 at today', `
    import { resolveTimeSpec } from './cores/free/reminders/src/chat-commands.ts';
    assert.equal(resolveTimeSpec('at noon today', now)?.kind, 'ok');
    assert.equal(resolveTimeSpec('at noon \\n\\ntoday', now)?.kind, 'ok');
    assert.equal(resolveTimeSpec('at noon' + ' '.repeat(n) + 'X', now), null);
    assert.equal(resolveTimeSpec('at noontoday', now), null);
  `],
  ['37 option number', `
    import { parseBareOptionNumber } from './onboarding/interview/engine-internals.ts';
    for (const value of [' 2 ', 'OPTION 2 . ', 'number 2)', 'no. 2', '#2']) {
      assert.equal(parseBareOptionNumber(value), 2);
    }
    assert.equal(parseBareOptionNumber('2' + ' '.repeat(n) + 'X'), null);
    assert.equal(parseBareOptionNumber('2' + ' '.repeat(n) + ')'), 2);
  `],
  ['38 name phrase', `
    import { extractAgentNameFromFreeform as extract } from './onboarding/interview/extract-agent-name.ts';
    for (const value of ["I'm Jane", 'I am Jane', 'I’m Jane', 'I  am Jane']) {
      assert.equal(extract(value), 'Jane');
    }
    assert.equal(extract('I' + ' '.repeat(n) + 'X'), null);
    assert.equal(extract('I' + ' '.repeat(n) + 'am Jane'), 'Jane');
  `],
  ['45 projection narrative', `
    import { replaceMarkedBlock, PROJECTION_BLOCK_START as start, PROJECTION_BLOCK_END as end } from './tasks/projection/parse.ts';
    const block = start + '\\n\\nBODY\\n\\n' + end + '\\n';
    assert.equal(replaceMarkedBlock('TEXT \\t\\n\\u00a0', 'BODY'), 'TEXT\\n\\n' + block);
    const narrative = 'X' + ' '.repeat(n) + 'Y';
    assert.equal(replaceMarkedBlock(narrative, 'BODY'), narrative + '\\n\\n' + block);
  `],
  ['46 projection body', `
    import { replaceMarkedBlock, PROJECTION_BLOCK_START as start, PROJECTION_BLOCK_END as end } from './tasks/projection/parse.ts';
    assert.equal(replaceMarkedBlock('', '\\n\\n BODY \\n\\n'), start + '\\n\\n BODY \\n\\n' + end + '\\n');
    const body = 'X' + '\\n'.repeat(n) + 'Y';
    assert.equal(replaceMarkedBlock('', body), start + '\\n\\n' + body + '\\n\\n' + end + '\\n');
  `],
]

for (const [name, body] of cases) {
  test(`CodeQL ${name}: hostile input completes with the correct result`, () => {
    const script = `import assert from 'node:assert/strict';
      const n = 200_000;
      const now = new Date('2026-04-15T00:00:00Z');
      ${body}`
    const result = spawnSync(process.execPath, ['--eval', script], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      encoding: 'utf8',
      timeout: 3_000,
    })
    expect(result.error, `${name}: ${result.stderr}`).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  }, 10_000)
}
