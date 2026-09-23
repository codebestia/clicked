# ADR-NNNN: <short imperative title>

- **Status:** proposed | accepted | superseded by ADR-NNNN (drop it if nothing supersedes this)
- **Date:** YYYY-MM-DD (for backfilled records: the date the record was written, with the note that the decision predates it)
- **Supersedes:** ADR-NNNN (drop the line if nothing, and link the replacement
  record when there is one)

## Context

What forced a decision. Two or three short paragraphs at most: the constraint, the
thing that broke or would have broken, and the options that were actually on the
table. Link the docs, schema or code the decision is about, with file paths.

Write down what the codebase looked like *before* the decision. An ADR whose
context only makes sense to someone who was in the review thread is not doing
its job.

## Decision

What was chosen, in the present tense, as a rule somebody can follow. If the
decision is enforceable in code (a check constraint, a validator, a rule in the
send path), say where.

## Consequences

What this buys, and what it costs. Both are required — an ADR with only upsides
is missing the part that will matter in six months.

- Positive consequence.
- Negative consequence, or the thing this makes harder later.
- Follow-on work this created, with the issue number if there is one.

## Alternatives rejected

One bullet per alternative, each with the reason it lost. If the rejection
reason is not recorded anywhere in the repo and you are reconstructing it,
say so explicitly instead of writing a plausible rationale — an unverified
"we rejected X because Y" is worse than "the record does not say why X was
rejected".

- **Alt A** — why it lost.
- **Alt B** — why it lost.

## Sources

Everything a reader needs to check this record against the code:

- schema: `apps/backend/src/db/schema.ts` (`<symbol>`)
- migration: `apps/backend/drizzle/NNNN_....sql`
- implementation: `path/to/file.ts`
- tests: `apps/backend/src/__tests__/<file>.test.ts`
- discussion: issue #NNN, PR #NNN (full links)
