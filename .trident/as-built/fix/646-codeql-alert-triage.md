## #646 — CodeQL alert triage and enforceable merge-gate truth

### What changed

The staged alert export contains 46 open rows: 44 high and 2 medium. That reconciles #646's 44-high count with #626's 46-untriaged count: they measure severity and total state respectively. Enumeration was `jq 'length, group_by(.severity)'` over the supplied table, not a hand count.

The workflow now says that `test` is the sole required context (.github/workflows/ci.yml:167-172), matching the measured ruleset fixture that resolves `required: ['test']` while separately observing both produced check names (trident/__tests__/ci-gate.test.ts:1085-1106). The choice is to correct the claim rather than require a second context: `test` already needs typecheck, lint, purity, layering, and every test shard (.github/workflows/ci.yml:439-465), while the separately produced analysis signal is not part of that aggregator. A text guard makes the corrected workflow claim fail if the old two-context statement returns (scripts/ci/ci-workflow.test.ts:165-178).

The confirmed code repair rejects every `data:` URL in the static HTML document renderer (landing/chat-react/HtmlDoc.tsx:73-95). Previously only `data:text/html` was rejected, so an author able to supply an HTML document could place an active payload under another `data:` media type in a surviving URL attribute. The regression exercises an SVG payload (landing/chat-react/__tests__/html-doc.test.tsx:92-96). This joins the existing sanitizer vocabulary: dangerous URLs are removed from URL-bearing attributes by default (landing/chat-react/HtmlDoc.tsx:64-95); it introduces no new error or verdict.

### Classification method and boundary

Every row below was enumerated from the supplied JSON table with `jq -r '.[] | [...] | @tsv'`; therefore the table is complete for that artifact. “Unknown” remains distinct from “false positive”: it means this lane did not establish both reachability and security impact. Several alerts point at source that no longer contains the reported operation. For that absence check, `rg -n 'Math\.random|randomBytes'` across the four reported files found the positive control `randomBytes` at runtime/adapters/claude-code/persistent/repl-session.ts:6 and no `Math.random`; those rows remain unknown rather than being laundered into false positives.

The fix boundary is one directly demonstrated browser execution class, alert 9. Alert 47 is also a real defect but belongs to the manifest grammar and needs its own performance fixture; combining that independent parser change would enlarge this security PR without strengthening the sanitizer repair. All other rows are retained as unknown unless the current tree itself proves the analyzer's security interpretation wrong.

| Alert | Rule | Classification | Current-tree evidence and concrete rationale |
|---:|---|---|---|
| 22 | `js/bad-tag-filter` | unknown | The reported regex is still the first transform in an HTML-to-text fallback (cores/free/email/src/mime.ts:92-102), but downstream interpretation was not proved here. |
| 17 | `js/double-escaping` | unknown | Entity decoding occurs after tags are removed (cores/free/email/src/mime.ts:102-117); whether a consumer later interprets the resulting text as markup was not proved here. |
| 20 | `js/incomplete-multi-character-sanitization` | unknown | Remaining tags are removed before entity decoding (cores/free/email/src/mime.ts:102-117); sink behavior remains unproved. |
| 19 | `js/incomplete-multi-character-sanitization` | unknown | The style-block expression feeds the same plaintext fallback (cores/free/email/src/mime.ts:92-102); exploitability remains unproved. |
| 18 | `js/incomplete-multi-character-sanitization` | unknown | The script-block expression feeds the same plaintext fallback (cores/free/email/src/mime.ts:92-102); exploitability remains unproved. |
| 21 | `js/incomplete-multi-character-sanitization` | false positive | The expression removes comments from a repository-owned SVG inside a test before paint assertions (landing/__tests__/favicon-serving.test.ts:129-145); no attacker data or production sink reaches it. |
| 13 | `js/incomplete-sanitization` | unknown | The replacement formats stored research topics into a Markdown table (cores/free/research/src/chat-commands.ts:272-287); this lane did not establish the renderer's backslash semantics. |
| 14 | `js/incomplete-sanitization` | unknown | The transform places bounded user content into model prompt lines (onboarding/interview/agent-name-suggester.ts:358-370); no code-execution sink was established. |
| 15 | `js/incomplete-sanitization` | unknown | The transform places bounded correction text into model prompt lines (onboarding/interview/personality-character-suggester.ts:401-413); no code-execution sink was established. |
| 16 | `js/incomplete-sanitization` | unknown | The transform bounds prompt text and escapes line breaks and quotes (onboarding/persona-gen/summarize.ts:187-200); no code-execution sink was established. |
| 9 | `js/incomplete-url-scheme-check` | real defect — fixed | An HTML-document author could retain an active non-HTML `data:` URL in `src`, `href`, or another screened attribute because the predicate covered only one media type; all `data:` schemes are now removed (landing/chat-react/HtmlDoc.tsx:64-95). |
| 2 | `js/insecure-randomness` | unknown | The staged line now tests credential kind rather than randomness (gateway/wiring/build-import-substrate.ts:335-346); the current tree no longer contains the reported operation. |
| 1 | `js/insecure-randomness` | unknown | The staged line now assigns an existing credential secret (gateway/wiring/build-import-substrate.ts:327-345); the current tree no longer contains the reported operation. |
| 6 | `js/insecure-randomness` | unknown | The staged location is now session dispatch/error handling rather than the reported random call (gateway/wiring/build-llm-call-substrate.ts:1374-1392); current reachability cannot be classified from the stale instance. |
| 5 | `js/insecure-randomness` | unknown | The staged location no longer contains the reported random call (gateway/wiring/build-llm-call-substrate.ts:1355-1370); current reachability cannot be classified from the stale instance. |
| 4 | `js/insecure-randomness` | unknown | The staged location no longer contains the reported random call (gateway/wiring/build-llm-call-substrate.ts:178-194); current reachability cannot be classified from the stale instance. |
| 3 | `js/insecure-randomness` | unknown | The staged location no longer contains the reported random call (gateway/wiring/build-llm-call-substrate.ts:178-194); current reachability cannot be classified from the stale instance. |
| 7 | `js/insecure-randomness` | unknown | The current staged line is ordinary pool control flow, and the file has no reported random call (runtime/adapters/claude-code/persistent/pool.ts:383-399); the stale instance cannot establish current impact. |
| 8 | `js/insecure-randomness` | unknown | The current staged line is spawn control flow, and the file has no reported random call (runtime/adapters/claude-code/persistent/spawn.ts:865-881); the stale instance cannot establish current impact. |
| 11 | `js/insufficient-password-hash` | false positive | SHA-256 produces a short stable secret fingerprint for identity comparison, not a password verifier (runtime/adapters/claude-code/persistent/repl-session.ts:704-714); password-cost guidance does not apply to that use. |
| 12 | `js/insufficient-password-hash` | false positive | SHA-256 hashes the HTTP body, then HMAC-SHA-256 authenticates the message with the shared secret (runtime/internal-signature.ts:41-52); this is request signing, not password storage. |
| 25 | `js/polynomial-redos` | unknown | The reported normalization expression remains at client-core/index.ts:73; caller-controlled maximum length and worst-case timing were not established here. |
| 26 | `js/polynomial-redos` | unknown | The reported project-memory normalization remains at connect/shared-project-memory-mirror.ts:113; input bounds and timing were not established here. |
| 27 | `js/polynomial-redos` | unknown | The reported project-list normalization remains at connect/unified-project-list.ts:216; input bounds and timing were not established here. |
| 29 | `js/polynomial-redos` | unknown | The reported calendar expression remains at cores/free/calendar/src/backend.ts:941; an attacker-reachable unbounded input was not established here. |
| 28 | `js/polynomial-redos` | unknown | The reported command expression remains at cores/free/calendar/src/chat-commands.ts:119; worst-case timing relative to chat input limits was not established here. |
| 33 | `js/polynomial-redos` | unknown | The reported reminder expression remains at cores/free/reminders/src/chat-commands.ts:500; worst-case timing relative to chat input limits was not established here. |
| 32 | `js/polynomial-redos` | unknown | The reported reminder expression remains at cores/free/reminders/src/chat-commands.ts:484; worst-case timing relative to chat input limits was not established here. |
| 31 | `js/polynomial-redos` | unknown | The reported reminder expression remains at cores/free/reminders/src/chat-commands.ts:470; worst-case timing relative to chat input limits was not established here. |
| 30 | `js/polynomial-redos` | unknown | The reported reminder expression remains at cores/free/reminders/src/chat-commands.ts:458; worst-case timing relative to chat input limits was not established here. |
| 34 | `js/polynomial-redos` | unknown | Model output is matched by the fenced-JSON expression at cores/free/research/src/backend.ts:445-453; its upstream response bound and timing were not established here. |
| 35 | `js/polynomial-redos` | unknown | A package name is normalized at cores/runtime/loader.ts:69-80; manifest size bounds and worst-case timing were not established here. |
| 36 | `js/polynomial-redos` | unknown | An archetype name is slugged at onboarding/archetypes/library.ts:274-282; caller bounds and worst-case timing were not established here. |
| 37 | `js/polynomial-redos` | unknown | User option text reaches the reported expression at onboarding/interview/engine-internals.ts:1458-1472; worst-case timing under actual message limits was not established here. |
| 38 | `js/polynomial-redos` | unknown | User text is passed to a supplied phrase expression at onboarding/interview/extract-agent-name.ts:215-229; the specific pattern and input bound need joint analysis. |
| 40 | `js/polynomial-redos` | unknown | Entity names are normalized before an 80-character output cap (runtime/entity-slug.ts:27-38), but there is no demonstrated input cap before the expression. |
| 41 | `js/polynomial-redos` | unknown | Slug normalization precedes the 31-character output cap (runtime/slug-grammar.ts:157-167), but there is no demonstrated input cap before the expression. |
| 42 | `js/polynomial-redos` | unknown | Model text reaches fenced-JSON extraction (scribe/extract.ts:314-334); upstream response bounds and worst-case timing were not established here. |
| 44 | `js/polynomial-redos` | unknown | Each compiled-truth line reaches the generated-body expression (scribe/reflect/jaccard.ts:136-151); line bounds and worst-case timing were not established here. |
| 43 | `js/polynomial-redos` | unknown | Each compiled-truth line reaches the H1 expression (scribe/reflect/jaccard.ts:136-151); line bounds and worst-case timing were not established here. |
| 46 | `js/polynomial-redos` | unknown | Projection bodies are trimmed by the reported expression (tasks/projection/parse.ts:71-86); accepted body bounds and worst-case timing were not established here. |
| 45 | `js/polynomial-redos` | unknown | Existing task text is trimmed by the reported expression (tasks/projection/parse.ts:71-81); accepted document bounds and worst-case timing were not established here. |
| 47 | `js/redos` | real defect — deferred | A malicious Core author can supply a capability string whose ambiguous repeated separators consume exponential validation time during manifest parsing (cores/sdk/manifest.ts:51-60). It needs a dedicated bounded-time regression and grammar-preserving rewrite. |
| 23 | `js/stack-trace-exposure` | unknown | The generic response primitive serializes an arbitrary body (gateway/http/surface-kit.ts:107-124); complete caller-value analysis was not established here. |
| 24 | `js/stack-trace-exposure` | unknown | The upload handler serializes an arbitrary body (gateway/upload/import-resume-handler.ts:345-349); complete caller-value analysis was not established here. |
| 10 | `js/xss-through-dom` | false positive | Raw HTML is parsed, forbidden elements are removed, and every surviving element has handlers and dangerous URLs stripped before nodes are imported (landing/chat-react/HtmlDoc.tsx:107-127, landing/chat-react/HtmlDoc.tsx:157-180). The analyzer reports the parse boundary, not an unsanitized sink. |

### Mutation evidence

| Guard | Mutation and printed landing line | Red | Restored green |
|---|---|---|---|
| Reject all `data:` schemes | Changed landing/chat-react/HtmlDoc.tsx:80 from `startsWith('data:')` to `startsWith('data:text/html')`; diff and line 80 were printed before the run. | `html-doc.test.tsx` failed at line 95 because the SVG data URL survived. | `html-doc.test.tsx`: 12 pass, 0 fail. |
| Required-context claim drift | Restored the old two-context sentence at .github/workflows/ci.yml:167-168; line 167-168 were printed before the run. | `ci-workflow.test.ts` failed at line 172 because the sole-context claim disappeared. | `ci-workflow.test.ts`: 78 pass, 0 fail. |

### Verification

Focused green run: `bun test landing/chat-react/__tests__/html-doc.test.tsx scripts/ci/ci-workflow.test.ts` — 90 pass, 0 fail before mutation and again after restoration. `bash scripts/ci/typecheck-all.sh` checked all 51 TypeScript configurations and passed. `bash scripts/ci/lint.sh` passed every reported guard with zero findings. The local leak gate found zero findings in every rule it could run, but exited 3 because its external PII denylist is unavailable in this lane; this is explicitly an incomplete result, not a clean claim.

### Deliberately not done

No repository setting was changed, no second required status context was introduced, and no alert was dismissed through an API. The independent manifest-regex defect and every unknown row remain explicit follow-up work. `SPEC.md` is unchanged because this repair enforces the existing static-document no-script boundary described at landing/chat-react/HtmlDoc.tsx:1-36; it does not change the product decision.
