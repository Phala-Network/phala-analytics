CREATE TABLE circulation_daily (
  date TEXT PRIMARY KEY,
  ethereum REAL NOT NULL,
  base REAL,
  phala REAL,
  khala REAL,
  source TEXT NOT NULL CHECK (source IN ('archive', 'api'))
);
CREATE TABLE cloud_daily (
  date TEXT PRIMARY KEY,
  total_users INTEGER NOT NULL,
  total_vms INTEGER NOT NULL,
  running_vms INTEGER NOT NULL,
  total_vcpu INTEGER NOT NULL,
  pha_usd REAL,
  captured REAL,
  source TEXT NOT NULL
);
CREATE TABLE vault_settlements (
  block_number INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  settled_at INTEGER NOT NULL,
  rewards REAL NOT NULL,
  total_assets REAL NOT NULL,
  PRIMARY KEY (block_number, log_index)
);
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
