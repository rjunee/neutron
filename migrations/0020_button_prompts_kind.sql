-- 0020_button_prompts_kind.sql
--
-- Sprint 28 Codex r4 P2 — persist `ButtonPrompt.kind` so the
-- image-gallery flag survives a re-emit / resend / duplicate-start
-- recovery path. Without this column, `ButtonStore.rowToPrompt(...)`
-- reconstructs prompts with `kind` always undefined, and any reuse
-- of an existing button_prompts row sends the portrait gallery as
-- a plain button keyboard with no thumbnails.
--
-- NULL means "no explicit kind" (back-compat with pre-Sprint-28
-- rows). The application code treats NULL as `'buttons'` (default).

ALTER TABLE button_prompts ADD COLUMN kind TEXT;
