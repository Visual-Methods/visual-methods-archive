CREATE TABLE IF NOT EXISTS collector_runs (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  rows_written INTEGER NOT NULL DEFAULT 0,
  sample_interval REAL,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS traffic_realtime_path (
  window_key TEXT NOT NULL,
  path TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  sample_interval REAL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (window_key, path)
);

CREATE TABLE IF NOT EXISTS traffic_daily_summary (
  date TEXT PRIMARY KEY,
  visits INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  sample_interval REAL,
  source TEXT NOT NULL,
  finalized_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traffic_daily_path (
  date TEXT NOT NULL,
  path TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  sample_interval REAL,
  source TEXT NOT NULL,
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (date, path)
);

CREATE TABLE IF NOT EXISTS traffic_monthly_summary (
  month TEXT PRIMARY KEY,
  visits INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  finalized_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traffic_monthly_path (
  month TEXT NOT NULL,
  path TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (month, path)
);

CREATE TABLE IF NOT EXISTS traffic_monthly_dimension (
  month TEXT NOT NULL,
  dimension_type TEXT NOT NULL,
  dimension_value TEXT NOT NULL,
  visits INTEGER NOT NULL DEFAULT 0,
  page_views INTEGER NOT NULL DEFAULT 0,
  sample_interval REAL,
  source TEXT NOT NULL,
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (month, dimension_type, dimension_value)
);

CREATE INDEX IF NOT EXISTS idx_realtime_path_page_views
  ON traffic_realtime_path (window_key, page_views DESC);

CREATE INDEX IF NOT EXISTS idx_daily_path_date_page_views
  ON traffic_daily_path (date, page_views DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_path_page_views
  ON traffic_monthly_path (month, page_views DESC);

CREATE INDEX IF NOT EXISTS idx_monthly_dimension_lookup
  ON traffic_monthly_dimension (month, dimension_type, page_views DESC);
