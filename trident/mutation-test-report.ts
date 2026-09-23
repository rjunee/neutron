// Bun may omit passing case names from console output in a large parent suite.
// Read its JUnit serialization strictly: a passed case is one self-closing
// testcase element, while filtered and failing cases have child status elements.
export function passedCase(report: string, name: string, classname = ''): boolean {
  const lines = report.trimEnd().split(/\r?\n/)
  if (lines.shift() !== '<?xml version="1.0" encoding="UTF-8"?>') return false
  const stack: string[] = []
  let rootSeen = false
  let rootClosed = false
  let matches = 0
  let passed = false
  for (const line of lines) {
    const row = line.trim()
    if (rootClosed) return false
    if (/^<testsuites name="bun test" tests="\d+" assertions="\d+" failures="0" skipped="\d+" time="[\d.]+">$/.test(row)) {
      if (rootSeen || stack.length) return false
      rootSeen = true
      stack.push('testsuites')
    } else if (/^<testsuite name="[^"]*" file="[^"]+"(?: line="\d+")? tests="\d+" assertions="\d+" failures="0" skipped="\d+" time="[\d.]+" hostname="[^"]+">$/.test(row)) {
      if (!stack.length || stack.at(-1) === 'testcase') return false
      stack.push('testsuite')
    } else if (row.startsWith('<testcase')) {
      const caseRow = row.match(/^<testcase name="([^"]*)" classname="([^"]*)" time="[\d.]+" file="[^"]+" line="\d+" assertions="\d+"( \/)?>$/)
      if (!caseRow || stack.at(-1) !== 'testsuite') return false
      const isPassed = caseRow[3] === ' /'
      if (caseRow[1] === name) {
        matches++
        passed = isPassed && caseRow[2] === classname
      }
      if (!isPassed) stack.push('testcase')
    } else if (row === '<skipped />') {
      if (stack.at(-1) !== 'testcase') return false
    } else if (row === '</testcase>' || row === '</testsuite>' || row === '</testsuites>') {
      if (stack.pop() !== row.slice(2, -1)) return false
      if (row === '</testsuites>' && stack.length) return false
      if (row === '</testsuites>') rootClosed = true
    } else {
      return false
    }
  }
  return rootSeen && rootClosed && stack.length === 0 && matches === 1 && passed
}
