# EverydayFuel — Handover to Next Chat

**Date:** 2026-08-19
**From:** Laguna (DeepSeek V4 Flash), pass 4
**Status:** Build + tests green; working tree NOT committed (see §6)

---

## 1. Project at a glance

Local-first nutrition tracker (Android APK via Capacitor + web preview). Source of truth: **`Ai Guidelines/`** (master spec, governance rules, AI logs) + **`PLAN.md`** + the actual code.

```
UI events → services (food/ai/import/export/backup) → domain logic → repositories → SQLite
```

Core principle: **Gemma interprets. Code calculates. SQLite remembers.**

---

## 2. What is implemented and working

- SQLite schema v001 (12 tables) + migrations + repositories + fallback connection
- Deterministic domain: nutrition scaling, hydration gating, goals, scoring (unchanged, per spec)
- UI: dashboard (ring, macros, hydration breakdown, 1-tap recents), history (trend chart, heatmap, day list), goals view, all modals
- Services: CSV export, CSV import, Supabase migration, backup archive, GemmaClient (native bridge + deterministic fallback parsers)
- Native: Capacitor Android project, `GemmaPlugin.kt` (MediaPipe LLM), barcode/label camera input stub
- **Pass 2 additions:** FoodService pipeline, text logging, journal search + quick-log, action hub (edit/duplicate/delete), edit modal with amount multiplier, numpad water, CSV import wiring, backup wiring, barcode string lookup, 28-day historical score computation, vitest test suite
- **Pass 3 additions:** restore-from-backup (service `restoreBackupArchive` + Settings UI wiring, fallback-store replacement path, atomic via transaction when available, FK-safe clear/insert order), CSV import now handles quoted fields with commas, 48 new regression tests (backup/restore, Gemma fallback parsers, CSV import/export, barcode/alias/food repositories) — suite now 82 tests
- **Pass 4 additions:** real-SQLite regression coverage using the existing `sql.js` dependency (no new deps, no production code touched):
  - `src/data/migrations/migration.test.ts` (7 tests) — the actual `v001__init.sql` runs on a real SQLite engine: all 12 tables + 5 indexes created, migration idempotency, FK enforcement (orphan food_logs rejected), NOT NULL/CHECK constraints (confidence range, water source enum), `schema_version` round-trip, byte-level export/reload persistence
  - `src/data/repositories/sqlite-real.test.ts` (27 tests) — a thin adapter wraps sql.js in the Capacitor `SQLiteDBConnection` surface, then exercises every repository against a REAL SQL engine: food insert/update/upsert/alias-JOIN/fuzzy-LIKE-with-bound-LIMIT, log insert/JOIN food_name/SUM totals/duplicate/update/delete, water GROUP BY by source, goal end-date closing + boundary resolution + overlap validation, daily records, observations, imports, barcode ON CONFLICT re-map + verified flag, combos (create/get/list/update/cascade delete, FK rejection), FK cascades (foods → aliases/barcodes) and the no-silent-history-loss rule (foods with logs can't be deleted), combo expansion round-trip (repo combo → domain `expandCombo` → logs → daily totals match), and backup/restore round-trip on real SQLite (full-table equality, complete replacement, transaction rollback on constraint failure leaves DB untouched, empty-archive restore)
  - `src/services/ai/gemma-client.test.ts` (+4 tests, 11 → 15) — label OCR edge cases: unit-suffixed values, "of which" sub-lines, missing macros stay 0, and a documented test locking the preserved old-app behavior for kJ-first EU energy lines
  - `src/types/sql-js.d.ts` — minimal ambient declarations for the untyped `sql.js` package (test-only)

## 3. Verification status

| Check | Result |
|---|---|
| `npm run build` (tsc strict + Vite) | ✅ passes |
| `npm test` (vitest 4.1.11, 120 tests, 9 files) | ✅ passes |
| Real-SQLite migration + repository + backup/restore round-trips (sql.js in-memory engine, migration.test.ts + sqlite-real.test.ts) | ✅ passes — all repository SQL (JOINs, GROUP BY, LIKE, SUM, bound LIMIT, ON CONFLICT) now proven against a real SQL engine, including FK-safe restore ordering with `PRAGMA foreign_keys = ON` |
| FoodService pipeline (service test w/ in-memory connection) | ✅ passes |
| Backup/restore round trip + restore atomicity/rollback (backup.test.ts + sqlite-real.test.ts) | ✅ passes |
| Gemma fallback text + label-OCR parsers (15 tests) | ✅ passes |
| Manual click-through on device/browser | ❌ NOT run (no browser/device in environment) |

## 4. Known limitations (unchanged, documented in pass-3 log)

- Fallback connection is a degraded shim: UPDATE statements not applied (edit/rename won't persist in fallback mode), water GROUP BY and `combo_items` not simulated. Restore in fallback mode bypasses SQL and replaces the store wholesale (correct, but the other degraded behaviors still apply). Note: the real-SQLite suite proves all these queries work correctly on the real engine — the shim is the only degraded path.
- Backup archives are plain JSON, **not actually encrypted** despite the button label (spec §23 asks for encrypted backup — pending).
- Native ML Kit label OCR, camera barcode scanning, food-image analysis = **Phase 7, not done**
- On-device Gemma inference requires the native plugin + model file on the device
- `btn-save-goals` still creates a new goal per save (pre-existing)
- Label-OCR fallback parser preserves the old-app regex (old_app/api/index.py): for kJ-first EU energy lines it captures the kJ value as `caloriesPer100g` — locked in by a regression test (gemma-client.test.ts), documented, not "fixed" because that would change preserved old-app behavior; revisit when wiring Phase 7.
- History day view shows real food names now (`food_name` join added)

## 5. What's next (from PLAN.md §9 handoff)

1. **Full native ML Kit integration** — label OCR (scanner modal `ai-file-input` already triggers a "Phase 7" toast), real camera barcode decoding into `BarcodeRepository.lookupBarcode`, food-image analysis → observations. The label-OCR fallback parser is now regression-locked (including its kJ quirk — fix it here if desired).
2. **P2P transfer** (Phase 9) — encrypted device-to-device via existing import/export/restore logic
3. **Laptop/desktop view** (Phase 10)
4. **Offline validation pass** (Phase 11) — verify all core flows with network off
5. ~~More regression tests~~ — the pass-3 open gaps are closed: real-SQLite migration test via sql.js, OCR parsing edge cases, combo expansion round-trip through repos (pass 4). Remaining possible coverage: repository tests on the degraded fallback shim, CSV export date-range/water-source rows, scoring against the old app's representative outputs (spec §29 regression comparison)
6. ~~Restore-from-backup UI~~ — done in pass 3 (Settings → Restore from Backup Archive)
7. Encrypted backup format (spec §23) — current archives are plain JSON

## 6. Before you start

- **The working tree is NOT committed.** Pass-4 changes: `src/data/migrations/migration.test.ts` (new), `src/data/repositories/sqlite-real.test.ts` (new), `src/types/sql-js.d.ts` (new), `src/services/ai/gemma-client.test.ts` (+4 OCR tests). Commit this pass first.
- `vitest` is a devDependency; the "test" script runs `vitest run` (120 tests, 9 files).
- The sql.js real-SQLite tests need no configuration: `initSqlJs()` loads `node_modules/sql.js/dist/sql-wasm.wasm` automatically in Node. Do not delete `src/types/sql-js.d.ts` — it is the type declaration for the untyped `sql.js` package (tsc strict would fail without it).
- AI work logs live in `Ai Guidelines/ai logs/logs/` which is **git-ignored by design** (matches previous passes).
- Read `Ai Guidelines/NutritionOS — Agent Governance & Development Rules.md` (em-dash in filename) before editing; PLAN.md §7 lists what must NOT change (scoring, hydration gating, goal resolution, v001 schema, domain types, CSV export format).
- Commands: `npm run dev` (web), `npm run build`, `npm test`, `npm run cap:sync` / `cap:run` (Android).
