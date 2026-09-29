## 2026-09-28 — Verify newly consumed native snapshot bytes

Metadata alone could accept same-size, valid-JSON rewrites when filesystem
timestamps aliased. Directory snapshot capture and registered import now
fingerprint their newly consumed range and reject a digest mismatch with the
bytes subsequently captured or parsed
(`scripts/build-timeline-codex-discover.ts:56`, `:66`, `:139`, `:166`).
This comparison does not detect rewrites completed before fingerprinting begins
or made after the capture or parsing pass ends; those rewrites can remain
undetected when metadata also permits them.
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

The first coordinated integration check on `9ae1928c12fffe7fae55ccf0fdea0e09a027a4f3`
passed all 51 TypeScript projects but failed this pre-existing rewrite control.
The unchanged base and candidate carried identical guard and test blobs. After
this repair, `bash scripts/check-shared-host.sh` on the frozen integrated code
revision `a6b70aa328a02036121ce5ece73477a5ed269e4a` exited zero on 2026-09-29:
all 51 TypeScript projects and all 1,751 discovered test files across 19 lanes
passed. Its before/after suite-input identity remained
`2a20e9db0bd2335103e28999e4da5b2df1a0e862994cafb20a67144e6d379e72`.
Independent native review passed. Complete-diff Claude Fable review found no
runtime or test blocker, but required narrower claims about the comparison
window; bounded arbitration accepted the exact corrected wording above.
Only documentation and these new records changed after that code validation.
The final publication head still requires its own CI; this is not a portable
receipt, deployment proof or completion of #1313.
