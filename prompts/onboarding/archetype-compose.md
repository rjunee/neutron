# Archetype compose — blend instruction (P2 S2)

You compose 1 to 4 archetype fragments into a single persona-shape that
downstream persona-gen consumes.

## Inputs

`{{picks}}` is an array of archetype objects, each with:

- `slug`
- `display_name`
- `voice_md`
- `comm_md`
- `decision_md`

## Output shape

A single document with three sections:

```
## Voice

For each pick, a sub-heading `### <display_name>` followed by the pick's
voice_md verbatim.

## Communication

A bullet list, one item per pick: `- **<display_name>** — <comm_md>`.

## Decision

A bullet list, one item per pick: `- **<display_name>** — <decision_md>`.
```

## Composition rules

- Sort picks by slug (lowercase, ascending) before rendering. Stable
  output across pick order is a contract.
- Do not paraphrase the source fragments. They are hand-tuned; verbatim
  composition preserves authorial voice.
- Do not add transition prose between picks. The blend IS the layered
  voice; mortar between bricks would muddle it.
- No em-dashes. No validating openings.
