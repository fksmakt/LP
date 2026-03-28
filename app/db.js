const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(path.join(dbDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('employee','contractor')),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft','sent','signed','cancelled')),

    -- 雇用者情報
    employer_name TEXT,
    employer_address TEXT,
    employer_rep TEXT,

    -- 受信者情報
    recipient_name TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    recipient_address TEXT,

    -- 契約条件
    start_date TEXT,
    end_date TEXT,
    position TEXT,
    work_location TEXT,
    work_hours TEXT,
    salary INTEGER,

    -- 業務委託専用
    project_name TEXT,
    contract_amount INTEGER,
    payment_terms TEXT,
    deliverables TEXT,

    -- テンプレート・ファイル
    template_id TEXT,
    pdf_path TEXT,
    signed_pdf_path TEXT,

    -- 署名
    sign_token TEXT UNIQUE,
    sign_expires_at TEXT,
    signer_ip TEXT,
    signature_data TEXT,

    -- メモ
    notes TEXT,

    -- タイムスタンプ
    created_at TEXT DEFAULT (datetime('now','localtime')),
    sent_at TEXT,
    signed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft','sent','paid','cancelled')),

    -- 発行者情報
    issuer_name TEXT,
    issuer_address TEXT,
    issuer_phone TEXT,
    issuer_email TEXT,
    issuer_bank_name TEXT,
    issuer_bank_branch TEXT,
    issuer_bank_type TEXT,
    issuer_bank_number TEXT,
    issuer_bank_holder TEXT,

    -- クライアント情報
    client_name TEXT NOT NULL,
    client_email TEXT,
    client_address TEXT,
    client_dept TEXT,
    client_contact TEXT,

    -- 請求詳細
    issue_date TEXT,
    due_date TEXT,
    items TEXT DEFAULT '[]',

    -- 金額
    subtotal INTEGER DEFAULT 0,
    discount INTEGER DEFAULT 0,
    tax_rate INTEGER DEFAULT 10,
    tax_amount INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,

    -- その他
    notes TEXT,
    pdf_path TEXT,

    -- タイムスタンプ
    created_at TEXT DEFAULT (datetime('now','localtime')),
    sent_at TEXT,
    paid_at TEXT
  );

  CREATE TABLE IF NOT EXISTS templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// デフォルト設定
const defaultSettings = [
  ['company_name', '株式会社サンプル'],
  ['company_address', '東京都渋谷区〇〇1-2-3'],
  ['company_phone', '03-1234-5678'],
  ['company_email', 'info@example.com'],
  ['company_rep', '代表取締役 山田太郎'],
  ['smtp_host', ''],
  ['smtp_port', '587'],
  ['smtp_user', ''],
  ['smtp_pass', ''],
  ['smtp_from_name', ''],
  ['smtp_from_email', ''],
  ['base_url', 'http://localhost:3000'],
  ['invoice_prefix', 'INV'],
  ['next_invoice_seq', '1'],
  ['tax_rate', '10'],
  ['bank_name', ''],
  ['bank_branch', ''],
  ['bank_type', '普通'],
  ['bank_number', ''],
  ['bank_holder', ''],
];

const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [key, value] of defaultSettings) insertSetting.run(key, value);

module.exports = db;
