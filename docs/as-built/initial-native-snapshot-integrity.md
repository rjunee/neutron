## 2026-09-28 — Verify newly consumed native snapshot bytes

A same-size, valid-JSON rewrite between descriptor validation and an initial
registered read could be accepted when filesystem timestamps aliased. Metadata
alone did not bind the captured range to the bytes parsed. Both directory
snapshot capture and registered import now fingerprint their newly consumed range
before the existing race boundary and compare it with the captured or parsed
bytes (`scripts/build-timeline-codex-discover.ts:35`, `:56`, `:139`, `:166`).
Reads use at most 64 KiB per chunk. A checkpointed import starts both passes at
the saved offset; an unchanged range performs no file reads. Checkpoint version,
custody, path checks, limits and receipt projection retain their existing contract.

The additional verification reads are reported: `scan.readBytes` is the total of
`parsedBytes` and `verificationBytes`
(`scripts/build-timeline-codex-discover.ts:176`). A successful nonempty new range
is read twice. The library guide documents this accounting. This change does not
verify the durable checkpoint prefix, does not alter the normative specification,
and does not resolve #1313's older-prefix rewrite limitation.

Tests perform actual file rewrites while making observed timestamps identical;
they do not wait for filesystem clock ticks. The physical-read control measures
offsets and returned bytes, proves unchanged imports make zero reads, and admits
valid appends beyond the captured boundary
(`scripts/build-timeline-codex-discover.test.ts:38`, `:285`, `:307`). Removing both
digest comparisons made all three selected regressions fail: directory capture,
initial registered capture, and a newly appended registered range. Restoring the
comparisons restored the green result; each rejected rewrite remains valid JSON.

Validation on the isolated change based on `e69d0c773c776a92f8a2c13297c7d6d03feca3c9`:
`bun test scripts/build-timeline-codex-discover.test.ts scripts/build-timeline-codex-import.test.ts scripts/build-timeline-sources.test.ts scripts/__tests__/build-timeline-server.test.ts`
passed 68 tests with 434 assertions. The server fixture required loopback socket
permission after the sandbox rejected its ephemeral listener. Root and Trident
`tsc --noEmit` checks passed, as did ESLint on both changed TypeScript files and
`git diff --check`. Dependencies were installed locally with
`bun install --frozen-lockfile --offline`. Full-suite and publication validation
remain with the integrating change; no deployment or private consumer change is
claimed here.
