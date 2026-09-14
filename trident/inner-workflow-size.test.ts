import { describe, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The Workflow tool rejects scripts above 512 KiB. Keep 32 KiB free so ordinary
// maintenance cannot silently put the build loop back on the hard boundary.
const WORKFLOW_TOOL_LIMIT_BYTES = 512 * 1024
const REQUIRED_HEADROOM_BYTES = 32 * 1024
const MAX_INNER_WORKFLOW_BYTES = WORKFLOW_TOOL_LIMIT_BYTES - REQUIRED_HEADROOM_BYTES
const INNER_WORKFLOW_PATH = fileURLToPath(new URL('./inner-workflow.mjs', import.meta.url))

describe('inner-workflow.mjs Workflow tool limit', () => {
  test('keeps real shipped script below the limit with maintenance headroom', () => {
    const actualBytes = statSync(INNER_WORKFLOW_PATH).size

    expect(
      actualBytes,
      `real shipped inner-workflow.mjs is ${actualBytes} bytes; must be at most ${MAX_INNER_WORKFLOW_BYTES} bytes ` +
        `(${REQUIRED_HEADROOM_BYTES} bytes below the Workflow tool's ${WORKFLOW_TOOL_LIMIT_BYTES}-byte limit)`,
    ).toBeLessThanOrEqual(MAX_INNER_WORKFLOW_BYTES)
  })
})
