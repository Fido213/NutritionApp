# EverydayFuel — Build Completion Plan

**Status:** Planning + Implementation Pass  
**Objective:** Complete the remaining migration phases per the NutritionOS specification and hand off to the next builder.

---

## 1. Current State Assessment

The codebase is at an **intermediate migration state** (between Phases 2–5 of the master spec). The following is implemented and working:
- SQLite schema (v001) with migrations, all repositories, and fallback connection
- Domain logic for nutrition math, hydration, scoring, goals
- Basic domain unit tests
- Core UI state store + dashboard/history/goals views
- CSV export service
- Backup/restore service (data structures only)
- Supabase legacy import service
- GemmaClient with deterministic fallback parser
- Native GemmaPlugin (Kotlin) registered in MainActivity
- Vite + TypeScript build passes; Vitest tests run

**Blocked / incomplete:**
- No input method is wired: text logging, barcode scanning, camera capture, label OCR
- GemmaClient is never instantiated in main.ts
- Multiple UI modal handlers are referenced in HTML but never connected
- History view only scores the selected date (no historical score computation)
- Food observations and aliases have no repository/service
- Backup/restore and CSV import are not wired to UI buttons
- food_logs INSERT in fallback path has column-order fragility

---

## 2. Implementation Plan (this pass)

### Phase A: Foundation — Food Resolution Service & Observations

**File:** `src/services/food/food-service.ts` (new)

Creates a `FoodService` that orchestrates the full food-resolution pipeline:

```
GemmaClient.interpretTextLog(input)
  → validateItems
  → for each InterpretedFoodItem:
     foodRepo.findByNormalizedName(normalized)
     → found? return FoodReference
     → not found? foodRepo.upsertFromAI(name, nutrients, confidence) → return FoodReference
  → for each resolved food, create FoodObservation + FoodLogEntry
```

**Files affected:**
- `src/data/repositories/observation.repo.ts` (new) — CRUD for `food_observations`
- `src/data/repositories/alias.repo.ts` (new) — CRUD for `food_aliases`
- `src/data/types.ts` — (no change needed; types already defined)

### Phase B: Text Logging Flow

**File:** `src/main.ts` (modify)

Wire the journal text input + GemmaClient:

1. Instantiate `GemmaClient` on app init
2. On journal search / text-submit event:
   - Call `gemmaClient.interpretTextLog(text)`
   - Resolve each item through `FoodService.resolveInterpretedFoods()`
   - Insert `FoodObservation` records
   - For each resolved food, calculate nutrition via domain `calculateNutrition()`
   - Insert `FoodLogEntry` records via `logRepo.insertFoodLog()`
   - Refresh dashboard state

### Phase C: UI Wiring

**File:** `src/main.ts` (modify)

Wire all currently-unimplemented modal handlers:

| Handler | Element ID | Action |
|---|---|---|
| Journal search | `journal-search` | Fuzzy search foods (existing repo method) |
| Journal result click | `journal-results` | Quick-log a food |
| Action hub edit | `hub-btn-edit` | Open edit modal with pre-filled values |
| Action hub duplicate | `hub-btn-duplicate` | Duplicate log to selected date |
| Action hub delete | `hub-btn-delete` | Delete log |
| Edit save | `btn-save-edit` | Save edited log (with amount multiplier) |
| Numpad enter | `numpad-enter` | Insert custom water log |
| Numpad DEL | `numpad-del` | Delete last digit |
| CSV import click | `btn-import-csv` | Trigger file picker → parseCSV → insert logs |
| CSV file input | `csv-file-input` | Read file → parseCSV → insert logs |
| Backup click | `btn-backup` | Export all tables as JSON |
| Scanner mode toggle | (from scan-btn) | Open scanner modal |

### Phase D: Native Barcode Scanning

**Files:** `src/main.ts`, `src/ui/views/dashboard.ts`, `src/data/repositories/barcode.repo.ts`

Wire barcode scanning:
1. Scanner modal `btn-decode-label` / scan triggers Camera/Barcode scanning
2. On barcode read: lookup in `barcodeRepo.lookupBarcode(barcode)`
3. Found → resolve food → log entry
4. Not found → prompt user to scan nutrition label or manual entry

**Note:** The full native ML Kit integration (Phase 7) requires Android Kotlin changes beyond this pass. We wire the UI flow and the `BarcodeRepository.lookupBarcode` path using the Capacitor Camera API + a lightweight JS barcode decoder (or a placeholder that calls the native bridge once implemented). For this pass, we implement the **local barcode lookup** path (already in the repository) and wire the **scanner modal UI** to accept a barcode string input.

### Phase E: Historical Score Computation

**File:** `src/main.ts` + `src/ui/views/history.ts`

Currently `renderHistory` only receives the selected date's score. Implement:

```typescript
async function computeScoresForRange(startDate: string, endDate: string): Promise<Map<string, number>> {
  const range = getDateRange(endDate, 28); // or dynamic
  const scoresMap = new Map<string, number>();
  for (const date of range) {
    const goal = await goalRepo.getGoalForDate(date);
    const totals = await logRepo.getDailyTotals(date);
    const water = await waterRepo.getWaterTotalsBySource(date);
    const targets = mapGoalToTargets(goal);
    const hydration = calculateEffectiveHydration(water.explicit, water.drink, water.food, targets.waterTarget);
    const score = calculateScore(totals, targets, hydration);
    scoresMap.set(date, score.score);
  }
  return scoresMap;
}
```

Wire this into `refreshStateForDate` so the heatmap/trend chart get all scores, not just one.

### Phase F: Tests

**File:** `src/domain/domain.test.ts` (expand)

Add tests for:
- Combo expansion
- User corrections (`applyCorrection`)
- Hydration source separation (drink vs food classification)
- `resolveGoalForDate` edge cases (overlapping dates, boundary conditions)
- `calculateDelta` directions
- Malformed AI JSON parsing (`safeJsonParse`)
- `normalizeFoodName` edge cases
- Scoring component breakdown

Also verify vitest is configured and passes.

### Phase G: AI Work Log

**File:** `Ai Guidelines/ai logs/logs/[Laguna][pass 2][2026-08-19].md` (new)

Document all changes made in this pass per the required sections.

---

## 3. Files To Be Created/Modified

| File | Action | Purpose |
|---|---|---|
| `PLAN.md` | new | This document |
| `src/services/food/food-service.ts` | new | Food resolution orchestration |
| `src/data/repositories/observation.repo.ts` | new | FoodObservation CRUD |
| `src/data/repositories/alias.repo.ts` | new | FoodAlias CRUD |
| `src/data/repositories/food.repo.ts` | modify | Add `toFoodReference()` mapping |
| `src/main.ts` | modify | Wire all UI handlers + text logging + barcode scan |
| `src/ui/views/history.ts` | modify | Accept scores map for full range |
| `src/domain/domain.test.ts` | modify | Expand test coverage |
| `Ai Guidelines/ai logs/logs/[Laguna][pass 2][2026-08-19].md` | new | Work log |
| `Ai Guidelines/ai logs/README.md` | no change | Format reference |

---

## 4. Architectural Decisions

### 4.1 FoodService Layer

**Why:** The spec defines a clear flow: `UI → application/service → domain logic → repository → SQLite`. Currently `main.ts` calls repositories directly, mixing concerns. A `FoodService` in `services/food/` encapsulates the multi-step resolution + logging pipeline.

**Decision:** Create `src/services/food/food-service.ts` as the canonical entry point for all food-input methods. This keeps `main.ts` thin and routes all four input methods through a single resolution pipeline.

### 4.2 Observation Repository

**Why:** `food_observations` table exists in the schema but has no repository. Per spec §7, observations are the structured intermediate representation between AI interpretation and food log creation.

**Decision:** Create `observation.repo.ts` with `insert(observation)` and `findById(id)` methods. The `food_logs.observation_id` FK will link logs to observations for provenance.

### 4.3 Alias Repository

**Why:** `food_aliases` table exists but only `findByAlias` is in food.repo.ts. Per spec §9, alias resolution is a first-class concern.

**Decision:** Create `alias.repo.ts` with `create(alias)`, `findByNormalized(normalizedAlias)`, and `getAliasesForFood(foodId)` methods. Keep `findByAlias` in food.repo.ts as a convenience query.

### 4.4 Historical Score Computation

**Why:** The spec §20 says "History is derived from the logs and daily records. Do not duplicate it as a second permanent dataset." Currently scores are computed only for the selected date.

**Decision:** Compute scores on-demand for the date range needed by the history view. Pass a `Map<string, number>` (date → score) to `renderHistory`. Do not store scores in SQLite — derive them each time.

### 4.5 Fallback Connection Hardening

**Why:** The fallback connection (database.ts:97-208) is a minimal shim that doesn't handle all tables or column orders correctly.

**Decision:** For this pass, add the missing tables (`food_observations`, `food_aliases`, `imports`) to the fallback `query` and `run` handlers. Keep the fallback functional but not perfect — it's a graceful degradation path, not the primary mode.

---

## 5. Implementation Sequence

1. Create `observation.repo.ts` — CRUD for food_observations
2. Create `alias.repo.ts` — CRUD for food_aliases  
3. Add `toFoodReference()` to `food.repo.ts` — map DB Food → domain FoodReference
4. Create `food-service.ts` — orchestrate text-input resolution + logging
5. Harden fallback connection in `database.ts` — add missing tables
6. Wire text logging in `main.ts` — journal → GemmaClient → FoodService → refresh
7. Wire action hub handlers in `main.ts` — edit, duplicate, delete
8. Wire edit-modal save handler in `main.ts` — with amount multiplier
9. Wire numpad handlers in `main.ts` — custom water input
10. Wire journal search in `main.ts` — fuzzy search + quick-log
11. Wire CSV import in `main.ts` — file picker → parse → insert
12. Wire backup button in `main.ts` — export all tables
13. Wire barcode scan flow in `main.ts` — scanner modal → barcode lookup
14. Implement historical score computation in `main.ts` + pass to `renderHistory`
15. Expand `domain.test.ts` with additional test cases
16. Run build + tests
17. Write AI work log

---

## 6. Risks and Edge Cases

### 6.1 Fallback Connection Fragility (HIGH)
The fallback connection uses string matching (`statement.includes('FROM ...')`) to detect tables and hard-codes column positions in INSERT handlers. Changes to SQL column order will silently break the fallback. **Mitigation:** The fallback is only used when SQLite fails (extremely rare in production on Android). We harden it for the new tables but don't refactor the whole shim.

### 6.2 AI Output Trust Boundary (HIGH)
Per spec §28, AI output must be treated as untrusted. `safeJsonParse` handles malformed JSON, but the `GemmaClient` only validates item names and amounts. **Mitigation:** Keep the existing `validateItems` filter; do not expand AI output parsing beyond what's tested.

### 6.3 Historical Score Computation Cost (MEDIUM)
Computing scores for 28 dates requires 28 × (3 queries + 1 score calc) = ~84 DB queries per history tab view. **Mitigation:** Only compute when the history view is rendered or the selected date changes. The dataset is small (local nutrition app, ~30 foods/day max).

### 6.4 Goal Overlap on Creation (MEDIUM)
`goalRepo.createGoal()` sets the previous goal's `end_date` but doesn't check for overlaps with non-current goals. **Mitigation:** Use existing `validateNoOverlap` method in the goals view save handler.

### 6.5 Barcode Not Found (MEDIUM)
When a barcode isn't in the local DB, the UI must gracefully prompt for label scan or manual entry. **Implemented (pass 14, per spec §7.4 + user requirement):** local lookup → optional internet lookup (Open Food Facts) → on hit log + save locally; on miss/offline → scan-the-nutrition-label fallback (toast + camera/gallery OCR). Manual entry stays available via + MANUAL.

---

## 7. What DeepSeek Must NOT Change

1. **Scoring algorithm** (`src/domain/scoring.ts`) — preserve exact behavior per spec §18
2. **Hydration gating rule** (`src/domain/hydration.ts`) — preserve exact behavior per spec §16
3. **Goal date resolution** (`src/domain/goals.ts`) — preserve exact behavior per spec §17
4. **SQLite schema** (`v001__init.sql`) — do not modify; no new columns or tables in this pass
5. **Domain type interfaces** (`src/data/types.ts`, `src/domain/types.ts`) — stable contracts
6. **AI/deterministic boundary** — Gemma must only interpret; code must calculate
7. **Local-first principle** — no cloud dependencies
8. **Export CSV format** (`exportexample.csv`) — use as regression reference for column structure

---

## 8. Testing & Verification Requirements

- `npm run build` — TypeScript compilation + Vite production build must pass
- `npm test` — all domain tests must pass (vitest)
- Manual verification: text logging produces food logs with correct nutrition math
- Manual verification: editing a log updates its values in SQLite
- Manual verification: duplicating a log creates a copy on the target date
- Manual verification: history view shows scores for all visible dates
- Manual verification: CSV import creates food logs from parsed rows
- Manual verification: backup exports all tables as JSON

---

## 9. Handoff to Next Builder

After this pass, the next builder should pick up:
- Full native ML Kit integration for barcode scanning, OCR, and food image analysis (Phase 7)
- P2P transfer implementation (Phase 9)
- Laptop/desktop view enhancements (Phase 10)
- Offline validation pass (Phase 11)
- Additional test coverage for repositories and AI robustness
