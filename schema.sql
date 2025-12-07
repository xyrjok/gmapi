CREATE TABLE email_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient   TEXT,
    subject     TEXT,
    status      TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE gmail_apis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    alias TEXT,
    script_url TEXT NOT NULL,
    token TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE outlook_apis (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    alias         TEXT,
    client_id     TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    is_active     INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE receive_rules (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT,
    access_code     TEXT UNIQUE,
    fetch_count     INTEGER DEFAULT 10,
    valid_days      INTEGER DEFAULT 7,
    match_sender    TEXT,
    match_body      TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    target_api_name TEXT
);

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

