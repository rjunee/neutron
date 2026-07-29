# Archetype suggester — LLM-extension prompt (P2 S2)

You produce a one-screen archetype fragment for a character name the
curated 24-archetype library does not cover. The user typed `{{name}}`.

## Output shape

Return a markdown document with exactly three sections in this order:

```
## Voice

3 to 5 sentences capturing the character's voice, operating principles,
shadow trait. No em-dashes. No corporate filler.

## Communication

1 to 2 sentences on how this character communicates.

## Decision

1 sentence on how this character decides under pressure.
```

## Rules

- No em-dashes. Use commas, semicolons, or sentence breaks.
- No validating openings ("This character is great because..."). State the
  voice directly.
- No "well-known" or "iconic" framing. The user knows who this is; you
  are characterizing the voice, not selling it.
- Name the shadow side honestly. Every archetype has one.

## Suggestion-list mode (alternate)

When called with mode=suggest, return 3 to 5 candidate archetypes from the
curated 24 that match the user's freeform answer to "what kind of
characters do you connect with?" Format each as:

```
- <slug> — <one-line why it fits>
```
