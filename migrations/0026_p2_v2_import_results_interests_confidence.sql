-- 0026_p2_v2_import_results_interests_confidence.sql
--
-- P2 v2 S5 — add the two genuinely-new v2 columns to `import_results`
-- per Codex r1 P1 (post-S5): without these columns the runner's
-- `loadResult` strips `inferred_interests` + `confidence_by_inference`
-- on round-trip through SQLite, so the new analysis-presentation body
-- never renders the Outside-work section + the low-confidence callout
-- on production reads, AND `phase_state.non_work_interests` stays
-- empty so every user routes through `work_interview_gap_fill`.
--
-- Additive ADD COLUMN — no in-flight row can be stranded by adding a
-- nullable column. Default empty JSON so the parser's
-- `JSON.parse(row.inferred_interests_json)` never throws on a row that
-- predates this migration's columns.
--
-- Also adds `conversation_count INTEGER` so the new
-- analysis-presentation body can render an accurate "Based on N
-- conversations" anchor. Pre-S5 ImportResult had no such field; the
-- engine fell back to `entities.length`, which is a deduped top-50
-- entity list (NOT one row per conversation) so the rendered count
-- was systematically wrong for normal imports. The runner writes the
-- real count derived from `aggregated.totals.chunks` at persist time;
-- legacy rows (column NULL) collapse to the no-count clause in the
-- builder.

ALTER TABLE import_results ADD COLUMN inferred_interests_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE import_results ADD COLUMN confidence_by_inference_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE import_results ADD COLUMN conversation_count INTEGER;
