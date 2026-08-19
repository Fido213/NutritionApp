# EverydayFuel — Handover to Next Chat

**Date:** 2026-08-19
**From:** Laguna (DeepSeek V4 Flash), pass 3
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

## 3. Verification status

| Check | Result |
|---|---|
| `npm run build` (tsc strict + Vite) | ✅ passes |
| `npm test` (vitest 4.1.11, 82 tests, 7 files) | ✅ passes |
| FoodService pipeline (service test w/ in-memory connection) | ✅ passes |
| Backup/restore round trip + restore atomicity/rollback (backup.test.ts) | ✅ passes |
| Gemma fallback text + label-OCR parsers (11 tests) | ✅ passes |
| Manual click-through on device/browser | ❌ NOT run (no browser/device in environment) |

## 4. Known limitations (unchanged, documented in pass-3 log)

- Fallback connection is a degraded shim: UPDATE statements not applied (edit/rename won't persist in fallback mode), water GROUP BY and `combo_items` not simulated. Restore in fallback mode bypasses SQL and replaces the store wholesale (correct, but the other degraded behaviors still apply).
- Backup archives are plain JSON, **not actually encrypted** despite the button label (spec §23 asks for encrypted backup — pending).
- Native ML Kit label OCR, camera barcode scanning, food-image analysis = **Phase 7, not done**
- On-device Gemma inference requires the native plugin + model file on the device
- `btn-save-goals` still creates a new goal per save (pre-existing)
- History day view shows real food names now (`food_name` join added)

## 5. What's next (from PLAN.md §9 handoff)

1. **Full native ML Kit integration** — label OCR (scanner modal `ai-file-input` already triggers a "Phase 7" toast), real camera barcode decoding into `BarcodeRepository.lookupBarcode`, food-image analysis → observations
2. **P2P transfer** (Phase 9) — encrypted device-to-device via existing import/export/restore logic
3. **Laptop/desktop view** (Phase 10)
4. **Offline validation pass** (Phase 11) — verify all core flows with network off
5. **More regression tests** — repositories, migrations, backup/restore, import/export round-trips, Gemma fallback parsers (backup/restore, Gemma, CSV, barcode/alias repos now covered in pass 3; still open: real-SQLite migration test via sql.js, OCR parsing, combo expansion round-trip through repos)
6. ~~Restore-from-backup UI~~ — **done in pass 3** (Settings → Restore from Backup Archive)
7. Encrypted backup format (spec §23) — current archives are plain JSON

## 6. Before you start

- **The working tree is NOT committed.** Pass-3 changes: `src/services/backup/backup.ts` (restore service), `src/data/database.ts` (`isFallback`/`replaceFallbackStore`), `src/main.ts` (restore handler), `src/index.html` (restore button), `src/services/import/csv-import.ts` (quoted-field parsing fix), plus 5 new test files (`backup.test.ts`, `gemma-client.test.ts`, `csv-import.test.ts`, `csv-export.test.ts`, `repos.test.ts`). Commit this pass first.
- `vitest` is a devDependency; the "test" script runs `vitest run` (82 tests, 7 files).
- AI work logs live in `Ai Guidelines/ai logs/logs/` which is **git-ignored by design** (matches previous passes).
- Read `Ai Guidelines/NutritionOS — Agent Governance & Development Rules.md` (em-dash in filename) before editing; PLAN.md §7 lists what must NOT change (scoring, hydration gating, goal resolution, v001 schema, domain types, CSV export format).
- Commands: `npm run dev` (web), `npm run build`, `npm test`, `npm run cap:sync` / `cap:run` (Android).
