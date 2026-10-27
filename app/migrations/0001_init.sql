CREATE TABLE circulation_day (
  date TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('ethereum', 'base')),
  totalSupply REAL NOT NULL,
  reward REAL NOT NULL,
  sunsetReward REAL NOT NULL,
  phalaChainBridge REAL NOT NULL,
  khalaLegacyChainBridge REAL NOT NULL,
  khalaChainBridge REAL NOT NULL,
  sygmaBridge REAL NOT NULL,
  portalBridge REAL NOT NULL,
  vaultBalance REAL NOT NULL,
  vaultTotalAssets REAL NOT NULL,
  vaultTreasuryAssets REAL NOT NULL,
  vaultUnstakeLocked REAL NOT NULL,
  vaultReward REAL NOT NULL,
  circulation REAL NOT NULL,
  vaultImplementation TEXT NOT NULL,
  vaultImplementationReviewed INTEGER NOT NULL CHECK (vaultImplementationReviewed IN (0, 1)),
  accrualMode TEXT NOT NULL,
  PRIMARY KEY (date, chain)
);
CREATE TABLE legacy_circulation_day (
  date TEXT PRIMARY KEY,
  phala REAL,
  khala REAL
);
CREATE TABLE vault_day (
  date TEXT PRIMARY KEY,
  flowDate TEXT NOT NULL,
  totalAssets REAL NOT NULL,
  treasuryAssets REAL NOT NULL,
  shareSupply REAL NOT NULL,
  unstakeLocked REAL NOT NULL,
  rewardRate REAL NOT NULL,
  dailyRewards REAL NOT NULL,
  dailyTreasuryRewards REAL NOT NULL,
  deposits REAL NOT NULL,
  withdrawRequests REAL NOT NULL,
  claims REAL NOT NULL,
  treasuryClaims REAL NOT NULL,
  stakers INTEGER NOT NULL,
  treasuryRatio INTEGER NOT NULL,
  depositCount INTEGER NOT NULL,
  withdrawRequestCount INTEGER NOT NULL,
  claimCount INTEGER NOT NULL,
  treasurySettlementCount INTEGER NOT NULL,
  sharePrice REAL NOT NULL,
  apr REAL NOT NULL,
  settlementTotalAssets REAL,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  vaultImplementation TEXT NOT NULL,
  vaultImplementationReviewed INTEGER NOT NULL CHECK (vaultImplementationReviewed IN (0, 1)),
  accrualMode TEXT NOT NULL
);
CREATE TABLE claim_day (
  date TEXT PRIMARY KEY,
  flowDate TEXT NOT NULL,
  khalaFree REAL NOT NULL,
  khalaStaked REAL NOT NULL,
  phalaFree REAL NOT NULL,
  phalaStaked REAL NOT NULL,
  khalaClaimCount INTEGER NOT NULL,
  phalaClaimCount INTEGER NOT NULL
);
CREATE TABLE cloud_daily (
  date TEXT PRIMARY KEY,
  total_users INTEGER NOT NULL,
  total_vms INTEGER NOT NULL,
  running_vms INTEGER NOT NULL,
  total_vcpu INTEGER NOT NULL,
  running_vcpu INTEGER,
  active_users INTEGER,
  pha_usd REAL,
  captured REAL,
  source TEXT NOT NULL CHECK (source IN ('archive', 'api', 'api-backfill'))
);
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
