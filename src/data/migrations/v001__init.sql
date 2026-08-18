PRAGMA foreign_keys = ON;

-- Foods Library
CREATE TABLE IF NOT EXISTS foods (
    id TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    calories_per_100g REAL,
    protein_per_100g REAL,
    carbs_per_100g REAL,
    fat_per_100g REAL,
    water_per_100g REAL,
    nutrition_basis TEXT NOT NULL DEFAULT 'per_100g',
    source_type TEXT NOT NULL DEFAULT 'user_entered',
    source_reference TEXT,
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_aliases (
    id TEXT PRIMARY KEY,
    food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    normalized_alias TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
    created_at TEXT NOT NULL,
    UNIQUE(food_id, normalized_alias)
);

CREATE TABLE IF NOT EXISTS food_barcodes (
    id TEXT PRIMARY KEY,
    food_id TEXT NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    barcode TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_observations (
    id TEXT PRIMARY KEY,
    food_id TEXT REFERENCES foods(id) ON DELETE SET NULL,
    source_type TEXT NOT NULL,
    estimated_amount REAL,
    final_amount REAL,
    amount_unit TEXT NOT NULL,
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0.0 AND confidence <= 1.0)),
    raw_input TEXT,
    interpretation_json TEXT,
    user_corrected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS food_logs (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    food_id TEXT NOT NULL REFERENCES foods(id),
    observation_id TEXT REFERENCES food_observations(id),
    amount_g REAL,
    amount_ml REAL,
    calories REAL NOT NULL,
    protein_g REAL NOT NULL,
    carbs_g REAL NOT NULL,
    fat_g REAL NOT NULL,
    water_ml REAL,
    note TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS combos (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS combo_items (
    id TEXT PRIMARY KEY,
    combo_id TEXT NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
    food_id TEXT NOT NULL REFERENCES foods(id),
    amount_g REAL,
    amount_ml REAL
);

CREATE TABLE IF NOT EXISTS water_logs (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    amount_ml REAL NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('explicit', 'drink', 'food')),
    food_log_id TEXT REFERENCES food_logs(id) ON DELETE CASCADE,
    note TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_records (
    date TEXT PRIMARY KEY,
    low_accuracy INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT,
    calories_target REAL NOT NULL,
    protein_target REAL NOT NULL,
    carbs_target REAL NOT NULL,
    fat_target REAL NOT NULL,
    water_target REAL NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    filename TEXT,
    imported_at TEXT NOT NULL,
    status TEXT NOT NULL,
    row_count INTEGER,
    error_count INTEGER
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_food_logs_date ON food_logs(date);
CREATE INDEX IF NOT EXISTS idx_water_logs_date ON water_logs(date);
CREATE INDEX IF NOT EXISTS idx_foods_normalized ON foods(normalized_name);
CREATE INDEX IF NOT EXISTS idx_food_aliases_normalized ON food_aliases(normalized_alias);
CREATE INDEX IF NOT EXISTS idx_goals_dates ON goals(start_date, end_date);
