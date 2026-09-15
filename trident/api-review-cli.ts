import { readFileSync } from 'node:fs'
import { reviewConfiguredSeat } from './api-review.ts'

const [tier, diffFile, ...task] = process.argv.slice(2)
try {
  const result = await reviewConfiguredSeat(tier ?? '', readFileSync(diffFile ?? '', 'utf8'), task.join(' '))
  if (result.status === 'connected') {
    process.stdout.write(result.text)
  } else {
    process.stderr.write(`${result.reason}\n`)
    process.exitCode = 3
  }
} catch {
  process.stderr.write(`review seat ${tier ?? '(unnamed)'}: configuration or invocation failed\n`)
  process.exitCode = 3
}
