import { expect, test } from 'bun:test'
import { passedCase } from './mutation-test-report.ts'

const begin = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="1" assertions="1" failures="0" skipped="0" time="0.1">\n  <testsuite name="fixture.test.ts" file="fixture.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.1" hostname="test">\n'
const end = '  </testsuite>\n</testsuites>\n'
const row = '    <testcase name="wanted" classname="" time="0.1" file="fixture.test.ts" line="1" assertions="1"'

test('JUnit positive control requires one complete passed case', () => {
  expect(passedCase(begin + row + ' />\n' + end, 'wanted')).toBe(true)
  expect(passedCase(begin + row + ' />\n' + end, 'another')).toBe(false)
  expect(passedCase(begin + row + ' />\n' + end, 'wanted', 'other suite')).toBe(false)
})

test('JUnit positive control rejects skipped, failed, duplicated, and malformed cases', () => {
  expect(passedCase(begin + row + '>\n      <skipped />\n    </testcase>\n' + end, 'wanted')).toBe(false)
  expect(passedCase(begin.replace('failures="0"', 'failures="1"') + row + '>\n      <failure />\n    </testcase>\n' + end, 'wanted')).toBe(false)
  expect(passedCase(begin + row + ' />\n' + row + ' />\n' + end, 'wanted')).toBe(false)
  expect(passedCase('garbage\n' + begin + row + ' />\n' + end, 'wanted')).toBe(false)
  expect(passedCase(begin + row + ' />\n' + end + 'garbage', 'wanted')).toBe(false)
  expect(passedCase(begin + row + ' />\n' + end + begin + end, 'wanted')).toBe(false)
  expect(passedCase(begin + row + ' />\n  garbage\n' + end, 'wanted')).toBe(false)
  expect(passedCase(begin + row + ' />\n', 'wanted')).toBe(false)
})
