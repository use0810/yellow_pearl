CREATE TABLE IF NOT EXISTS monthly_expenses (
  year_month TEXT PRIMARY KEY,
  actual_shipping INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now', '+9 hours'))
);
