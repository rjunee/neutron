// Bun may omit passing case names from console output in a large parent suite.
// Its JUnit receipt keeps each selected case and self-closes only passing cases.
export function passedCase(report: string, name: string, classname = ''): boolean {
  return report.split('\n').some(line => {
    const row = line.trim()
    return row.startsWith(`<testcase name="${name}" classname="${classname}"`)
      && row.endsWith('/>')
  })
}
