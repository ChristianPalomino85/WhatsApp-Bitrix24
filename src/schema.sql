PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template_name TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'es',
  sender_phone_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|scheduled|running|paused|done|error|canceled
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  total_targets INTEGER DEFAULT 0,
  meta_json TEXT
);

CREATE TABLE IF NOT EXISTS campaign_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  vars_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',   -- queued|sending|sent|delivered|read|failed|canceled
  last_error TEXT,
  wa_message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id, phone)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wa_message_id TEXT,
  type TEXT NOT NULL,                      -- sent|delivered|read|reply
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS senders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone_id TEXT NOT NULL UNIQUE,
  display TEXT,
  qps INTEGER DEFAULT 8,
  created_at TEXT NOT NULL
);

-- Cola persistente
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  phone_id TEXT NOT NULL,
  available_at INTEGER NOT NULL,       -- epoch ms
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' -- queued|processing|done|failed
);

CREATE INDEX IF NOT EXISTS idx_queue_sched ON queue(status, available_at);
