# NutritionOS — Master Migration & Build Specification

**Status:** Master specification for the initial whole-project transition  
**Objective:** Existing NutritionOS web app → local-first Android APK, while preserving product behavior and implementing the agreed QoL improvements.

---

## 1. Executive definition

The project is:

> **Web app → APK**
>
> **+ agreed QoL/data-quality improvements**
>
> **+ cloud → local**

This is not a greenfield redesign.

Preserve the existing product's UX decisions, nutrition/scoring behavior, workflows, historical-data concepts, and useful accumulated logic. Replace the infrastructure underneath them and clean up the implementation substantially.

Target result:

- one unified logging + dashboard application;
- no required cloud backend;
- SQLite as the local source of truth;
- local/on-device AI and vision;
- deterministic application-side nutrition mathematics;
- import/export and complete backup;
- optional local P2P transfer;
- laptop/desktop-compatible view where practical.

---

# 2. Hard scope boundary

Do not turn this migration into a larger personal-OS project.

Do not add:

- exercise/training tracking;
- sleep/recovery/wearable modules;
- social features;
- subscriptions/accounts;
- medical nutrition advice;
- giant global food-database infrastructure;
- RAG/vector databases;
- elaborate autonomous AI systems;
- unnecessary cloud synchronization;
- unrelated analytics.

Design for extensibility; do not implement unrelated future products.

---

# 3. Core principles

## 3.1 Core loop

> **Open → log → see result → leave.**

Logging should be fast.

## 3.2 AI / deterministic boundary

> **AI interprets. Code calculates. Database remembers.**

AI may:

- interpret natural language;
- identify foods;
- extract quantities;
- reconcile image observations and captions;
- structure OCR;
- provide missing nutritional reference estimates.

Application code owns:

- arithmetic;
- unit normalization;
- proportional scaling;
- aggregation;
- goal calculations;
- hydration rules;
- scoring;
- validation;
- persistence;
- imports/exports.

Do not make the LLM the authority for arithmetic.

## 3.3 AI is replaceable

Gemma is an implementation of the interpretation/knowledge layer, not the application's identity.

## 3.4 Precision follows effort

NutritionOS should support:

- high-effort users who weigh ingredients;
- normal users who photograph food and add a caption;
- low-effort users who simply type what they ate.

More precise evidence should produce more precise output.

## 3.5 Uncertainty is explicit

Do not pretend an AI estimate, a user measurement, and a nutrition label have equal precision.

Preserve provenance and confidence.

## 3.6 Avoid over-engineering

Prefer the simplest implementation that is reliable.

Do not create elaborate infrastructure simply because it is possible.

---

# 4. Current → target architecture

### Existing

```text
Telegram
  ↓
Python / Vercel
  ↓
Gemini
  ↓
Supabase
  ↑
Web dashboard
```

### Target

```text
                        NutritionOS APK
                              │
               ┌──────────────┼──────────────┐
               │              │              │
             Text        Food Image          Scan
               │              │          ┌────┴─────┐
             Gemma        ML Kit/native   Label    Barcode
               │              │            OCR        │
               │        Gemma/context       │       SQLite
               └──────────────┼─────────────┘         │
                              ↓
                    Structured observation
                              ↓
                    Food/reference resolution
                              ↓
                 Deterministic nutrition engine
                              ↓
                            SQLite
                              ↓
                       Daily calculation
                              ↓
                  Goal / hydration / scoring
                              ↓
                             UI
```

Capacitor provides the native shell/bridge around the HTML/CSS/TS application.

---

# 5. Frontend strategy

Keep the existing UI/UX where it is good:

- dashboard;
- calorie ring;
- macros;
- hydration;
- recents;
- journal;
- manual logging;
- history;
- trend chart;
- consistency heatmap;
- goals;
- modals;
- responsive desktop behavior.

Do **not** blindly preserve messy implementation.

Instead:

1. understand what current code does;
2. preserve intended behavior;
3. separate responsibilities;
4. standardize naming;
5. centralize business logic;
6. remove duplicated calculations;
7. remove obsolete cloud/service code;
8. keep the product visually/functionally recognizable.

The target is the **same product with substantially cleaner code**.

Prefer plain HTML + CSS + JavaScript/TypeScript rather than introducing a large frontend framework without a concrete need.

UI code should render state and trigger operations, not contain authoritative nutrition calculations or arbitrary database queries.

---

# 6. Code organization

Exact file names may be adapted to the existing project, but responsibilities should be clearly separated.

```text
app/
domain/
  nutrition/
  hydration/
  goals/
  scoring/
  logging/
data/
  sqlite/
  repositories/
  migrations/
services/
  food/
  ai/
  import/
  export/
  backup/
native/
  camera/
  barcode/
  ocr/
ui/
  views/
  components/
  state/
utils/
```

The structure should remain proportional to the application's size.

Expected flow:

```text
UI event
  ↓
application/service
  ↓
domain logic
  ↓
repository
  ↓
SQLite
  ↓
result/state
  ↓
UI
```

---

# 7. Primary food-input methods

NutritionOS has four first-class food-entry methods.

## 7.1 Text

Examples:

> `50g chicken, 100g rice`

or:

> `midnight oats containing 50g oats, 20g chia seeds, 120ml milk`

Gemma interprets:

- food identity;
- quantity;
- whether the input is separate food items or a named composite;
- ambiguity/context.

Do not encode quantities inside food names.

## 7.2 Food image

This is a **core v1 feature**.

The user photographs the actual food.

The native image pipeline should:

- analyze food regions/objects;
- obtain visual observations;
- use the planned physical/reference-ratio measurement process;
- estimate dimensions/geometry;
- estimate grams/volume where possible;
- turn native vision results into the NutritionOS structured observation format.

ML Kit's native output does not need to magically match NutritionOS's JSON schema. A NutritionOS adapter converts native output to our internal format.

### Image captions

A caption can accompany the image.

Gemma may reconcile:

- image-derived observations;
- caption wording;
- explicit quantities;
- known food information.

Explicit user quantities and corrections take precedence over uncertain image estimates.

## 7.3 Nutrition-label scan

This means photographing the **nutrition label**.

```text
Camera
 ↓
ML Kit OCR
 ↓
raw text
 ↓
Gemma structures/interprets
 ↓
validation
 ↓
user confirmation when appropriate
 ↓
food reference
 ↓
SQLite
```

## 7.4 Barcode

```text
Barcode scan
 ↓
SQLite barcode lookup
 ↓
found?
 ├─ yes → local product
 └─ no → optional internet lookup
             ↓
          found?
          ├─ yes → user confirms → save locally
          └─ no → ask user to scan nutrition label
```

Do not use Gemma to guess the identity of an unknown barcode.

The barcode is an identifier; the nutrition data comes from the local/external product record or the scanned label.

---

# 8. Unified structured-input contract

All input methods converge to a common internal representation.

At the interpretation boundary, input may contain units from the user/model.

After normalization, use canonical units internally:

- grams;
- milliliters;
- kcal;
- grams for macros;
- milliliters for water.

Do not repeatedly carry redundant unit fields throughout the application.

Preserve original wording where useful for provenance/raw-input history.

---

# 9. Food resolution

## 9.1 Canonical names

Foods have a canonical identity.

Do not create separate records merely because the wording differs.

## 9.2 Aliases

Aliases are explicit mappings to a canonical food.

Use:

```text
exact canonical
→ exact alias
→ fuzzy candidate search
→ context/Gemma resolution
→ user confirmation when ambiguous
```

Fuzzy search produces candidates; it must **not automatically create aliases**.

Do not allow:

> `chicken curry`

to silently map to:

> `chicken breast`

just because a fuzzy matcher found overlapping words.

## 9.3 Personalization

A newly discovered food can enter the local library.

Over time:

```text
AI estimate / barcode / label / user entry
 ↓
SQLite
 ↓
future lookup
```

The user's local food library becomes increasingly useful and reduces repeated AI work.

---

# 10. Nutritional-reference resolution

A nutritional reference can initially be AI-derived.

### Unknown food

```text
user input
 ↓
Gemma identifies food
 ↓
SQLite has no reference
 ↓
Gemma supplies a nutritional reference estimate
 ↓
validate/structure
 ↓
save reference to SQLite
 ↓
deterministic calculation
```

### Known food

```text
user input
 ↓
Gemma identifies food + quantity
 ↓
SQLite reference
 ↓
deterministic calculation
```

Thus Gemma initially provides both interpretation and missing knowledge; over time it increasingly acts only as an interpreter because the local database already contains the reference.

---

# 11. Food-reference provenance

A `foods` record should retain:

- canonical name;
- normalized name;
- nutrition basis;
- nutritional values needed for this migration;
- source type;
- optional source reference;
- confidence;
- creation/update timestamps.

Source types may include:

- `ai_estimate`;
- `barcode`;
- `nutrition_label`;
- `user_entered`;
- `imported`.

Do not add a generic `verified` flag to `foods`.

A barcode mapping may separately track whether the user explicitly confirmed the barcode-to-product relationship.

---

# 12. Deterministic nutrition calculation

For a per-100g reference:

```text
factor = actual_grams / 100
```

Then multiply each stored nutrient by that factor.

Example:

```text
165 kcal / 100g
× 250g
= 412.5 kcal
```

The same principle applies to protein, carbs, fat and water.

No LLM is required for this arithmetic.

---

# 13. User corrections

User corrections are authoritative.

Example:

```text
system estimate: 185g
user correction: 210g
```

The final calculation uses:

> **210g**

No AI re-analysis is necessary.

Where useful, preserve:

- original estimate;
- final corrected value;
- corrected-by-user state.

---

# 14. Food logs vs combos

Do not force every set of foods into a meal object.

### Separate foods

> `50g chicken, 100g rice`

means two independently logged food items.

### Composite/combo

> `Midnight oats containing 50g oats, 20g chia seeds, 120ml milk`

is a named reusable combination.

Combos are templates of ingredients.

When a combo is logged:

- copy its ingredients into the current day;
- calculate each independently;
- aggregate for display;
- historical logs become independent records.

Changing the template later must not rewrite historical logs.

---

# 15. SQLite schema

The schema should be implemented with foreign keys enabled and normal SQLite transaction/migration discipline.

## `foods`

```text
id                  TEXT PRIMARY KEY
canonical_name      TEXT NOT NULL
normalized_name     TEXT NOT NULL UNIQUE

calories_per_100g   REAL
protein_per_100g    REAL
carbs_per_100g      REAL
fat_per_100g        REAL
water_per_100g      REAL

nutrition_basis     TEXT NOT NULL
source_type         TEXT NOT NULL
source_reference    TEXT
confidence          REAL

created_at          TEXT NOT NULL
updated_at          TEXT NOT NULL
```

`nutrition_basis` may include:

- `per_100g`;
- `per_100ml`;
- `per_serving`.

Confidence is constrained to an appropriate 0–1 range.

## `food_aliases`

```text
id               TEXT PRIMARY KEY
food_id          TEXT NOT NULL
alias            TEXT NOT NULL
normalized_alias TEXT NOT NULL
source           TEXT NOT NULL
confidence       REAL
created_at       TEXT NOT NULL
```

Unique mapping per food + normalized alias.

## `food_barcodes`

```text
id        TEXT PRIMARY KEY
food_id   TEXT NOT NULL
barcode   TEXT NOT NULL UNIQUE
source    TEXT NOT NULL
verified  INTEGER NOT NULL DEFAULT 0
created_at TEXT NOT NULL
```

`verified` here means the user confirmed the barcode/product mapping, not that all nutrition knowledge is universally verified.

## `food_observations`

```text
id                  TEXT PRIMARY KEY
food_id             TEXT
source_type         TEXT NOT NULL
estimated_amount    REAL
final_amount        REAL
amount_unit         TEXT NOT NULL at this observation boundary
confidence          REAL
raw_input           TEXT
interpretation_json TEXT
user_corrected      INTEGER NOT NULL DEFAULT 0
created_at          TEXT NOT NULL
```

Canonical downstream data should normalize units.

## `food_logs`

```text
id              TEXT PRIMARY KEY
date            TEXT NOT NULL
food_id         TEXT NOT NULL
observation_id  TEXT

amount_g        REAL
amount_ml       REAL

calories        REAL NOT NULL
protein_g       REAL NOT NULL
carbs_g         REAL NOT NULL
fat_g           REAL NOT NULL
water_ml        REAL

note            TEXT

created_at      TEXT NOT NULL
```

Use the appropriate canonical quantity field for the food/drink type; do not store redundant unit metadata in normal operation.

Nutritional result fields represent the historical result of that specific log.

## `combos`

```text
id          TEXT PRIMARY KEY
name        TEXT NOT NULL
note        TEXT
created_at  TEXT NOT NULL
updated_at  TEXT NOT NULL
```

## `combo_items`

```text
id           TEXT PRIMARY KEY
combo_id     TEXT NOT NULL
food_id      TEXT NOT NULL
amount_g     REAL
amount_ml    REAL
```

## `water_logs`

```text
id          TEXT PRIMARY KEY
date        TEXT NOT NULL
amount_ml   REAL NOT NULL
source      TEXT NOT NULL
food_log_id TEXT
note        TEXT
created_at  TEXT NOT NULL
```

Sources:

- `explicit`;
- `drink`;
- `food`.

## `daily_records`

```text
date          TEXT PRIMARY KEY
low_accuracy  INTEGER NOT NULL DEFAULT 0
note          TEXT
created_at    TEXT NOT NULL
updated_at    TEXT NOT NULL
```

## `goals`

```text
id              TEXT PRIMARY KEY
name            TEXT NOT NULL
start_date      TEXT NOT NULL
end_date        TEXT
calories_target REAL NOT NULL
protein_target  REAL NOT NULL
carbs_target    REAL NOT NULL
fat_target      REAL NOT NULL
water_target    REAL NOT NULL
created_at      TEXT NOT NULL
```

Rules:

- `start_date` is the date the goal begins;
- `end_date` is the final date before the next goal begins;
- current goal has `NULL` end date;
- overlapping active goals must not be allowed.

## `app_settings`

```text
key   TEXT PRIMARY KEY
value TEXT NOT NULL
```

## `imports`

```text
id           TEXT PRIMARY KEY
source_type  TEXT NOT NULL
filename     TEXT
imported_at  TEXT NOT NULL
status       TEXT NOT NULL
row_count    INTEGER
error_count  INTEGER
```

Do not create permanent tables for history, daily score, or dashboard state merely to duplicate derived information.

---

# 16. Hydration

Store separately:

- explicit water;
- drink-derived water;
- food-derived water;
- effective hydration;
- target.

Effective hydration is derived.

The agreed gating rule:

If explicit water has not reached the target:

```text
effective achieved hydration = explicit water
```

while inferred water remains stored and available for display/context.

Once explicit water reaches the target:

```text
effective hydration =
explicit water
+ eligible inferred drink water
+ eligible inferred food water
```

The UI and export must retain the distinction.

---

# 17. Goals

Historical goal assignment is date-based.

Example:

```text
Cut
Jan 1 → Mar 14

Bulk
Mar 15 → current
```

A historical day automatically receives whichever goal covered that date.

Never retroactively relabel historical days with today's goal.

---

# 18. Scoring

Preserve the existing scoring implementation and behavior.

The new implementation must reproduce the old:

- score tier;
- score code;
- result;
- reason;
- visual state.

Do not redesign scoring during this migration.

Derived score information should be available to history and exports without becoming another source of truth.

---

# 19. QoL package

Implement:

1. exact percentages next to progress;
2. dynamic progress states;
3. daily ↓ / ✓ / ↑ indicators;
4. hydration source distinction and gating;
5. daily notes;
6. meal/log notes;
7. human low-accuracy day flag;
8. confidence metrics;
9. date-range export;
10. goal/phase-aware export;
11. import;
12. complete backup/restore;
13. reusable combo templates;
14. alias/fuzzy food resolution.

---

# 20. History

Retain:

- 7-day;
- monthly;
- yearly;
- trend chart;
- heatmap;
- selected-day details.

Enhance with the new metadata.

History is derived from the logs and daily records. Do not duplicate it as a second permanent dataset.

---

# 21. Export

Support:

- all time;
- date range;
- specific goal/phase.

Export useful historical information including:

- date;
- goal/phase;
- targets;
- actual calories/macros;
- hydration breakdown;
- score tier;
- score code;
- result;
- reason;
- confidence metrics;
- human low-accuracy flag;
- day note.

Remove exercise columns.

The existing exported CSV provided in the project context, including score-tier and reason fields, should be used as a regression reference.

---

# 22. Import

Support migration from external nutrition trackers/CSVs where practical.

Import behavior:

- map known fields;
- normalize dates/units;
- preserve imported provenance;
- validate;
- report failures;
- do not fabricate missing information.

An external source that has no water/goal/confidence/note data simply remains missing in those fields.

---

# 23. Backup and transfer

A complete backup represents the user's meaningful local state:

- foods;
- nutrition references;
- provenance;
- aliases;
- barcodes;
- observations;
- logs/history;
- combos/templates;
- water;
- daily records;
- goals;
- settings;
- relevant import metadata.

History is already in logs.

Derived score/dashboard state does not need a duplicated storage representation.

Support both:

### Encrypted backup

A portable encrypted local backup format with schema/app-version metadata.

### P2P transfer

Direct encrypted device-to-device transfer over a shared local network/hotspot, preferably using a pairing/QR flow.

Both use the same underlying import/export/restore logic.

No cloud server is required for either.

---

# 24. Offline requirements

Core workflows must work with no internet:

- app launch;
- text logging;
- known-food resolution;
- local Gemma;
- local ML Kit operations;
- history;
- goals;
- water;
- scoring;
- export;
- backup/restore;
- existing local barcodes.

Internet is optional for unknown-barcode lookup.

The app should never require internet for core nutrition tracking.

---

# 25. Laptop view

Reuse the same application/data model.

Do not create a completely separate nutrition application.

The frontend should support a laptop-sized presentation.

The exact local serving/connection mechanism can be implemented after the core APK is stable.

Desktop viewing must not become a blocker for the initial core migration.

---

# 26. Removed legacy infrastructure

Remove:

- Telegram;
- Telegram webhook;
- Vercel backend;
- Supabase client;
- Supabase authentication;
- Supabase REST access;
- cloud Gemini dependency;
- exercise functionality;
- exercise export fields;
- cloud synchronization queues.

Do not hide unused legacy functionality; remove it once the replacement is validated.

---

# 27. Native/runtime guidance

Preferred direction:

- Capacitor for the native shell/bridge;
- HTML/CSS/TS for UI/application logic;
- Kotlin/native plugins where Android capabilities are required;
- native ML Kit integration for OCR/barcode/vision;
- appropriate on-device Gemma runtime for local inference;
- SQLite for persistent local data.

Do not embed Python merely to preserve the old backend.

Use native code only where it provides a real capability/performance/integration advantage.

---

# 28. JSON and AI robustness

Every AI output must be treated as untrusted structured input.

Pipeline:

```text
model output
↓
sanitize
↓
parse
↓
schema validate
↓
domain validate
↓
use
```

Malformed output must not corrupt the database.

A simple failure/retry/user-error path is sufficient.

Do not create an elaborate AI self-repair system.

---

# 29. Testing

Minimum automated/regression coverage:

- proportional nutrition scaling;
- aggregation;
- combo expansion;
- user corrections;
- goal date resolution;
- scoring;
- hydration gating;
- water-source separation;
- alias/fuzzy resolution;
- malformed AI JSON;
- missing food references;
- OCR parsing;
- barcode failure/fallback;
- import;
- export;
- SQLite migrations;
- backup/restore.

The old app's representative outputs and supplied CSV should be used for regression comparisons.

For important migrated flows:

```text
old behavior
vs.
new behavior
```

must be compared.

Differences should be intentional and documented.

---

# 30. Migration execution order

## Phase 0 — checkpoint

Back up the current project and data.

## Phase 1 — audit

Inspect the project without major edits.

Map:

- files;
- dependencies;
- UI;
- state;
- Supabase operations;
- AI calls/prompts;
- calculations;
- exports;
- scoring;
- data flows;
- legacy/dead code.

## Phase 2 — skeleton

Create/standardize the new local application structure.

## Phase 3 — SQLite

Implement the schema, migrations, repositories, and CRUD.

## Phase 4 — deterministic domain

Implement nutrition, aggregation, goals, hydration, scoring.

## Phase 5 — local frontend connection

Refactor the existing frontend so it consumes local services/repositories instead of cloud APIs.

## Phase 6 — local AI

Integrate local Gemma through a clean interface.

## Phase 7 — native image/OCR/barcode

Add the four input paths.

## Phase 8 — QoL

Implement the agreed QoL package.

## Phase 9 — portability

Implement import/export/backup/P2P.

## Phase 10 — laptop view

Enable local desktop viewing where practical.

## Phase 11 — offline/regression validation

Turn off network access and verify all required offline workflows.

Then package the APK.

Do not proceed from a broken phase simply because later work may theoretically fix it.

---

# 31. Antigravity operating rules

For the initial whole-project migration:

### First

Inspect the project before making significant edits.

### Second

Produce the migration plan from the actual project.

### Third

Implement in controlled phases.

### Fourth

After each significant phase:

- build;
- test;
- inspect diff;
- verify intended behavior;
- checkpoint.

### Model usage

Use the strongest reasoning model available in the environment for:

- initial architecture;
- high-risk refactors;
- database migration;
- difficult debugging;
- final audit.

Use faster implementation agents for:

- mechanical refactors;
- configuration;
- routine tests;
- straightforward UI work;
- repetitive changes.

Use multiple agents only for genuinely separable work.

At the time of implementation, verify the exact models/tools currently available rather than hardcoding assumptions about names or capabilities.

### Do not:

- blindly rewrite the whole project;
- invent product features;
- change scoring without instruction;
- add cloud dependencies;
- reintroduce accounts;
- make Gemma authoritative for arithmetic;
- silently modify history;
- create aliases from ambiguous fuzzy matches;
- preserve obsolete code merely because it exists.

---

# 32. Acceptance criteria

The migration is complete when:

### Product

- The APK feels like the existing NutritionOS product.
- Dashboard and logging are unified.
- Existing scoring behavior is preserved.
- Agreed QoL features are implemented.

### Offline

- Core functions work without network.
- Local SQLite is the source of truth.
- Local AI/vision paths work as designed.

### Inputs

- text works;
- food-image logging works;
- caption-assisted image logging works;
- label OCR works;
- barcode lookup works;
- unknown barcode fallback works.

### Data

- goals remain historically correct;
- user corrections are authoritative;
- hydration sources remain separated;
- imports work;
- exports contain required score/reason/context;
- complete backups restore the user's state.

### Engineering

- cloud dependencies removed;
- code is substantially cleaner and standardized;
- UI is separated from business logic;
- deterministic calculations are testable independently;
- malformed AI output is safely rejected;
- no major duplicated source-of-truth logic remains.

---

# 33. Final mental model

```text
USER
 ↓
TEXT / FOOD IMAGE / LABEL / BARCODE
 ↓
ML KIT / GEMMA / LOCAL LOOKUP
 ↓
STRUCTURED FOOD + QUANTITY
 ↓
FOOD REFERENCE
   ├─ SQLite if known
   └─ Gemma estimate if unknown
 ↓
DETERMINISTIC NUTRITION MATH
 ↓
FOOD LOG / COMBO EXPANSION
 ↓
SQLITE
 ↓
DAILY AGGREGATION
 ↓
GOAL + HYDRATION + SCORE
 ↓
DASHBOARD / HISTORY / EXPORT
```

The two rules that should remain visible throughout implementation are:

> **Gemma interprets. Code calculates. SQLite remembers.**

and:

> **Preserve the product. Replace the infrastructure. Clean the implementation. Do not expand the scope.**
