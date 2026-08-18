# AI Work Logs

## Purpose

This folder records the work performed by AI agents on NutritionOS after each completed pass. Each log is a durable handoff and audit record: it states what was added, changed, removed, or fixed, the validation that was performed, and the remaining system status.

## Log location and naming

Completed logs belong in the `logs` subfolder. Use this filename format:

```text
[name of the ai][pass n][date].md
```

Where `n` is the sequential pass number for that AI and the date uses `YYYY-MM-DD`.

## Required sections

Every log must contain these sections, even when a section has no changes:

- Features made
- Refactors made
- Cleanup made
- Deletion made
- Bug fixes
- Current status

Status entries must distinguish completed validation from checks that could not be run. Logs should remain factual and scoped to the work performed in that pass.
