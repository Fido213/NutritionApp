# EverydayFuel — Handover to Next Chat

**Date:** 2026-08-19
**From:** Laguna (DeepSeek V4 Flash), pass 6
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
- **Pass 5 additions:** **encrypted backup format (spec §23)** — the Backup button now really encrypts:
  - `src/services/backup/encryption.ts` (new) — password-based encryption envelope via the built-in **Web Crypto API** (zero new dependencies, fully local/offline): PBKDF2-HMAC-SHA256 (200,000 iterations, 16-byte random salt) → AES-256-GCM (12-byte random IV). Envelope is JSON carrying base64 salt/iv/ciphertext + KDF params, so the file is self-contained and portable. `encryptBackup(jsonText, password)` → envelope string (throws on empty/whitespace-only password); `decryptBackup(payload, password)` → original JSON or `null` (wrong password, tampering, or non-envelope); `isEncryptedBackup(text)` → cheap format sniff.
  - `src/main.ts` — backup handler now prompts for a password (set + confirm), encrypts, then downloads; restore handler detects an encrypted file, prompts for the password, decrypts, then runs the existing parse/validate/restore flow. **Plain JSON archives from previous passes remain fully restorable without a password** (backward compatible).
  - `src/services/backup/encryption.test.ts` (new, 17 tests) — envelope structure (fields, base64 lengths, iteration count), no plaintext leakage inside the envelope, fresh salt/IV per run (two runs differ), empty/whitespace password rejection, byte-for-byte round-trip (also at the real default 200k KDF cost), decrypted output validates as an EverydayFuel archive, wrong password → null, missing envelope fields → null, plain JSON/garbage → null, AES-GCM authentication failure on tampered ciphertext → null, tampered salt → null, foreign format → null, and `isEncryptedBackup` true/false cases.
- **Pass 6 additions:** **scoring now reproduces the old app's full output contract (spec §18 + §29)**:
  - `src/domain/scoring.ts` — the numeric algorithm is untouched (score, scoreCode, components, clamping all identical), but `result`, `scoreTier` and `reason` now reproduce `old_app/app.js` `exportDataToCSV` byte-for-byte: `result` is the visual state (`Green`/`Grey`/`Red`), `scoreTier` is the legacy CSS class (`score-pos-5` … `score-0` … `score-neg-3` — replaces the invented word labels 'perfect'/'excellent'/…), and `reason` uses the legacy templated sentences ("Flawless day. Nailed everything: …", "Off target across the board (…)", etc.). `getScoreTier` (the invented word labels) was removed — nothing referenced it except `calculateScore` itself; the UI uses `getScoreColorClass`, which is unchanged.
  - `src/domain/scoring-regression.test.ts` (new, 3 tests) — replays **95 of the 96 rows of the supplied legacy export `exportexample.csv`** (the regression reference from spec §21/§29) through the new `calculateScore` and asserts byte-for-byte equality of `score`, `scoreCode`, `scoreTier`, `result` and `reason` against the old app's actual output. The single non-replayable row (`2026-05-03`) is asserted and documented: the legacy CSV records only "Pure Water (ml)" but the old app scored hydration against pure + drink/food water, so rows where the reason says "hydration goal met" while pure water is < 80% of target cannot be reconstructed from the CSV alone.
  - `src/domain/domain.test.ts` — updated `scoreTier` expectation ('perfect' → 'score-pos-5') and extended two `calculateScore` tests with legacy `result`/`reason` assertions.
  - `src/data/repositories/sqlite-real.test.ts` — fixed a **pre-existing flaky test**: the import-history test inserted two rows in the same millisecond, making `ORDER BY imported_at DESC` ambiguous in real SQLite (occasionally failed with 'csv' before 'supabase'). Now uses `vi.useFakeTimers()` with distinct system times so the ordering assertion is deterministic.

## 3. Verification status

| Check | Result |
|---|---|
| `npm run build` (tsc strict + Vite) | ✅ passes |
| `npm test` (vitest 4.1.11, 140 tests, 11 files) | ✅ passes (run 3× to confirm no flakes) |
| Scoring regression vs legacy export (scoring-regression.test.ts, spec §29) | ✅ passes — 95/96 rows of `exportexample.csv` reproduce `score`/`scoreCode`/`scoreTier`/`result`/`reason` byte-for-byte; the 1 non-replayable row (2026-05-03) is asserted + documented |
| Real-SQLite migration + repository + backup/restore round-trips (sql.js in-memory engine, migration.test.ts + sqlite-real.test.ts) | ✅ passes — all repository SQL (JOINs, GROUP BY, LIKE, SUM, bound LIMIT, ON CONFLICT) now proven against a real SQL engine, including FK-safe restore ordering with `PRAGMA foreign_keys = ON` |
| Encrypted backup (encryption.test.ts, 17 tests: PBKDF2→AES-GCM round-trip, tamper detection, wrong-password, envelope structure) | ✅ passes |
| FoodService pipeline (service test w/ in-memory connection) | ✅ passes |
| Backup/restore round trip + restore atomicity/rollback (backup.test.ts + sqlite-real.test.ts) | ✅ passes |
| Gemma fallback text + label-OCR parsers (15 tests) | ✅ passes |
| Manual click-through on device/browser | ❌ NOT run (no browser/device in environment) — the password prompt flow (window.prompt) and file download were not manually exercised |

## 4. Known limitations (unchanged, documented in pass-3 log)

- Fallback connection is a degraded shim: UPDATE statements not applied (edit/rename won't persist in fallback mode), water GROUP BY and `combo_items` not simulated. Restore in fallback mode bypasses SQL and replaces the store wholesale (correct, but the other degraded behaviors still apply). Note: the real-SQLite suite proves all these queries work correctly on the real engine — the shim is the only degraded path.
- Backup archives are **now encrypted by default** (PBKDF2 + AES-256-GCM, pass 5). One caveat: the password is prompted via `window.prompt` — this works in desktop browsers, but Android WebView support for `window.prompt` is unreliable, so the password prompt may need a custom modal when testing on-device (same pattern already used by the restore `window.confirm`).
- Native ML Kit label OCR, camera barcode scanning, food-image analysis = **Phase 7, not done**
- On-device Gemma inference requires the native plugin + model file on the device
- `btn-save-goals` still creates a new goal per save (pre-existing)
- Label-OCR fallback parser preserves the old-app regex (old_app/api/index.py): for kJ-first EU energy lines it captures the kJ value as `caloriesPer100g` — locked in by a regression test (gemma-client.test.ts), documented, not "fixed" because that would change preserved old-app behavior; revisit when wiring Phase 7.
- History day view shows real food names now (`food_name` join added)
- Scoring regression coverage has one blind spot, locked in by the test itself: `2026-05-03` in exportexample.csv is not replayable because the legacy CSV exports only pure water while the old app scored hydration against pure + drink/food water (the bridging water isn't in the file). The new hydration-gating rule (spec §16) also means the new app intentionally scores with `effectiveTotal` rather than the old raw sum — no legacy row contradicts this within the replayable set.
- Zero-target semantics preserved as-is (pre-existing): a 0 target yields a 0 component (no penalty) and reasons "calories lower than goal" etc. The legacy app would have divided by zero (→ +Infinity → "higher than goal"); no legacy CSV row has a zero target, so this was never observed in real data.

## 5. What's next (from PLAN.md §9 handoff)

1. **Full native ML Kit integration** — label OCR (scanner modal `ai-file-input` already triggers a "Phase 7" toast), real camera barcode decoding into `BarcodeRepository.lookupBarcode`, food-image analysis → observations. The label-OCR fallback parser is now regression-locked (including its kJ quirk — fix it here if desired).
2. **P2P transfer** (Phase 9) — encrypted device-to-device via existing import/export/restore logic
3. **Laptop/desktop view** (Phase 10)
4. **Offline validation pass** (Phase 11) — verify all core flows with network off
5. ~~More regression tests~~ — closed: real-SQLite migration + repository tests (pass 4), OCR parsing edge cases (pass 4), combo expansion round-trip (pass 4), **scoring vs the old app's representative outputs (pass 6, spec §29 — 95/96 rows of exportexample.csv byte-identical)**. Remaining possible coverage: repository tests on the degraded fallback shim, CSV export date-range/water-source rows.
6. ~~Restore-from-backup UI~~ — done in pass 3 (Settings → Restore from Backup Archive)
7. ~~Encrypted backup format~~ — done in pass 5 (spec §23; see §2/§4). Note for Phase 7/device work: replace `window.prompt` password entry with a proper in-app modal for Android WebView.

## 6. Before you start

- **The working tree is NOT committed.** Pass-6 changes: `src/domain/scoring.ts` (legacy result/scoreTier/reason text, `getScoreTier` removed), `src/domain/scoring-regression.test.ts` (new), `src/domain/domain.test.ts` (updated expectations + legacy-text assertions), `src/data/repositories/sqlite-real.test.ts` (flake fix), `src/domain/types.ts` (comment only). Commit this pass first.
- `vitest` is a devDependency; the "test" script runs `vitest run` (137 tests, 10 files).
- The sql.js real-SQLite tests need no configuration: `initSqlJs()` loads `node_modules/sql.js/dist/sql-wasm.wasm` automatically in Node. Do not delete `src/types/sql-js.d.ts` — it is the type declaration for the untyped `sql.js` package (tsc strict would fail without it).
- AI work logs live in `Ai Guidelines/ai logs/logs/` which is **git-ignored by design** (matches previous passes).
- Read `Ai Guidelines/NutritionOS — Agent Governance & Development Rules.md` (em-dash in filename) before editing; PLAN.md §7 lists what must NOT change (scoring, hydration gating, goal resolution, v001 schema, domain types, CSV export format).
- Commands: `npm run dev` (web), `npm run build`, `npm test`, `npm run cap:sync` / `cap:run` (Android).
