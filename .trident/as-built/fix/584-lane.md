## Issue #584 — inline path-token affordance

### What changed

The canonical web Markdown renderer now delegates clicks from standalone inline
`code` elements to the existing clipboard helper (`landing/chat-react/Markdown.tsx:223-243`).
Fenced code remains owned by its labelled Copy button, and code nested in an
anchor remains owned by navigation (`landing/chat-react/Markdown.tsx:231-237`).

Inline tokens now use explicit dark, light, and blue-bubble foreground tokens
(`landing/chat-react.html:98-102`, `landing/chat-react.html:193-196`) and a pointer
cursor; fenced code resets both inherited color and cursor behavior
(`landing/chat-react.html:623-633`). The focused checks calculate at least 4.5:1
contrast for all three bubble grounds (`landing/chat-react/__tests__/markdown-inline-code.test.tsx:87-95`).

### Decisions

Copy is the default intent only for standalone inline tokens. A linked token
keeps navigation as its single intent because the existing anchor vocabulary
intercepts recognized document links and opens the Documents tab
(`landing/chat-react/Markdown.tsx:203-218`). A fenced block keeps the existing
button vocabulary, whose label and copied state are already rendered by
`CodeBlock` (`landing/chat-react/Markdown.tsx:107-137`).

The renderer-level delegation applies to chat and Documents because both import
the same component (`landing/chat-react/ChatApp.tsx:28`,
`landing/chat-react/DocumentsTab.tsx:32`). The native parser was deliberately not
changed because the canonical renderer documents that parser as frozen pending
the shell work (`landing/chat-react/Markdown.tsx:7-14`).

### Mutation evidence

| Guard or outcome | Compiling mutation | Red result | Restored result |
|---|---|---|---|
| Fenced blocks do not use inline copy | `closest('pre, a')` → `closest('a')` at `landing/chat-react/Markdown.tsx:234` | “copies a standalone inline token but not a fenced block” failed because `block text` was copied | focused file: 3 pass |
| Linked tokens retain navigation-only intent | `closest('pre, a')` → `closest('pre')` at `landing/chat-react/Markdown.tsx:234` | “leaves a linked inline token to document navigation” failed because `brief.md` was copied | focused file: 3 pass |
| Non-empty inline token copies | `token.length === 0` → `token.length > 0` at `landing/chat-react/Markdown.tsx:236` | standalone-copy assertion failed with no clipboard write | focused file: 3 pass |
| Pointer affordance | `cursor: pointer` → `cursor: text` at `landing/chat-react.html:627` | CSS-contract assertion failed | focused file: 3 pass |
| Light-theme color is explicit | `#0b57d0` → `inherit` at `landing/chat-react.html:194` | light-theme color assertion failed | focused file: 3 pass |

The focused test owns these assertions at
`landing/chat-react/__tests__/markdown-inline-code.test.tsx:26-96`.

### Verification

- `bunx tsc -p landing/chat-react/tsconfig.json --noEmit` — green.
- `bash scripts/ci/lint.sh` — green.
- `bun test landing/chat-react/__tests__/markdown-inline-code.test.tsx landing/chat-react/__tests__/markdown-copy.test.ts landing/chat-react/__tests__/doc-link-open.test.tsx` — 8 pass, 0 fail.
- `bash scripts/ci/typecheck-all.sh` — the changed landing configurations passed,
  but the full 51-config matrix remained red in unchanged app, gateway, logger,
  onboarding, and root configurations. Those diagnostics are outside this lane.

### Deliberately not changed

No second renderer or feature path was added. Existing fenced-copy feedback was
not duplicated for inline tokens, document-link navigation was not replaced,
and the frozen native parser was not modified (`landing/chat-react/Markdown.tsx:7-14`).
No product decision in `SPEC.md` changed.
