## 2026-09-14 — Credential solicitation guidance and reachable settings alternative (#581)

### Change and evidence

The credential doctrine now prohibits asking for owner secrets in chat, including
paraphrases requesting authentication files, encoded material or screenshots
(`gateway/wiring/operating-doctrine.ts:162`). It directs the owner to the phone's
Integrations link or web General → Admin, asks only for completion confirmation,
and keeps an unavailable surface blocked (`gateway/wiring/operating-doctrine.ts:169`).
Already authorized non-chat credentials remain usable; unknown provenance goes to
settings (`gateway/wiring/operating-doctrine.ts:174`). The connect tool advertises
the same boundary (`gateway/cores/integrations-tools.ts:112`); its shared storage
call remains at `gateway/cores/integrations-tools.ts:162`, alongside the HTTP
service call at `gateway/http/cores-integrations-surface.ts:221`.

The brief's proposed custom link needed one reachability fix: the existing URL
allow-list at `app/lib/markdown-grammar.ts:107` only accepted the docs destination
for that scheme. The exact Integrations URL is now accepted at :115, with suffixes
rejected by `app/__tests__/markdown-render-parse.test.ts:289`. The app registers
the scheme at `app/app.json:11`; the renderer invokes the URL opener at
`app/lib/markdown-render.tsx:69`. The existing boolean URL vocabulary remains:
false renders a non-interactive link (`app/lib/markdown-render.tsx:457`).

### Decisions and acceptance scope

Preserve the agent-callable connect tool and shared service. This is a provenance
instruction, not a removal of agent capability. The safe alternative requires
only a setup-complete acknowledgment. Unknown provenance must not become implied
permission. Permit exactly the settings deep link, not arbitrary routes or URLs
containing credential parameters.

The delivered prompt contract is checked for both General and project turns at
`gateway/wiring/__tests__/build-live-agent-turn.test.ts:467`. It explicitly checks
both “Paste your API key here” and the paraphrase “Send me the authentication file
so I can finish connecting your account” as forbidden instructions. This is NOT
a behavioral model evaluation. No claim is made that matching prompt text proves
that a model will comply with the rule.

Arming: the fragment includes the rule at
`gateway/wiring/operating-doctrine.ts:201`, and the production composer builds it
at `gateway/wiring/build-live-agent-turn.ts:1998` and includes it at :2071 and :2101.
The composition regression test detects loss of its contents. CI executes the
partitioned test runner (`.github/workflows/ci.yml:437`), which discovers tests at
`scripts/run-tests.sh:235-240`. This continuously checks instruction delivery and
URL behavior independently of model cooperation. It does not mechanically refuse
arbitrary generated solicitation text.

### Mutation evidence

Each mutation was applied separately, its landing line printed and its file diff
printed before execution. Each targeted test failed, then passed after restoring
the source. The local mutation transcript is summarized in this table.

| Contract and landing line | Mutation | Red test | Restored |
| --- | --- | --- | --- |
| Doctrine :162 | NEVER → may ask | live-turn #581 | green |
| Doctrine :168 | paraphrase forbidden → permitted | live-turn #581 | green |
| Doctrine :169 | remove Markdown settings link | live-turn #581 | green |
| Doctrine :175 | authorized non-chat → any source | live-turn #581 | green |
| Doctrine :176 | unknown provenance → use tool | live-turn #581 | green |
| Doctrine :173 | unavailable surface → ask in chat | live-turn #581 | green |
| Connect description :112 | prohibition → request key | integrations-tools #581 | green |
| URL predicate :115 | remove exact allowance | markdown-render-parse #581 | green |
| URL predicate :115 | equality → prefix match | markdown-render-parse #581 | green |

Test file names above refer respectively to
`gateway/wiring/__tests__/build-live-agent-turn.test.ts:467`,
`gateway/cores/__tests__/integrations-tools.test.ts:315`, and
`app/__tests__/markdown-render-parse.test.ts:289`.

### Validation and deliberate limits

79 tests passed across the three files above plus
`gateway/wiring/__tests__/operating-doctrine.test.ts`. This is the complete local
test set, enumerated by explicit paths in the Bun command, not the whole suite.

A live behavioral test still needs to ask for a connection using both direct and
paraphrased credential requests, then verify an actionable settings response and
no solicitation. This network-free lane did not run that evaluation, a native
end-to-end tap test, or a model-output interception mechanism. Prompt assertions
are not substitutes for those checks. No new error taxonomy, service validation,
credential storage, shell remedy or product architecture was introduced.

Record location follows the lane's explicit `.trident/as-built/<branch>.md`
instruction over the repository's default permanent-shard location.

Lint (`bash scripts/ci/lint.sh`) passed. The all-config typecheck reported errors;
the new test's optional-property error was corrected and its full file reran
with 30 passing tests. A fresh gateway typecheck then reported only errors at
`gateway/transcription/__tests__/whisper-install.test.ts:186` (typed-array overload)
and `onboarding/history-import/__tests__/zip-writer.ts:10` (zlib type export).
The broader run also reported a missing `@types` definition for the app and an
overload error at `logger/__tests__/fire-and-forget.test.ts:301`. These checks
are not green; those files are outside this change's scope. The leak scan found
zero findings in executed rules but reported INCOMPLETE because the private PII
denylist rules could not run; it is not recorded as a clean gate.

The focused app check also passed: `bunx tsc --noEmit --skipLibCheck --target
ES2022 --module ESNext --moduleResolution bundler --types bun
app/lib/markdown-grammar.ts app/__tests__/markdown-render-parse.test.ts`.
All nine mutations were repeated successfully after correcting the optional
property in the composition fixture.

The repository matrix completed all 51 configurations and exited 1. The root
configuration also reported the three out-of-scope source errors listed above.
