/**
 * データベース層
 * node-sqlite3-wasm を使用（Windows でビルドツール不要・純粋 WASM）
 * better-sqlite3 互換 API でラップしているため、ルートファイルの変更不要
 */
const { Database: WasmDatabase } = require('node-sqlite3-wasm');
const path = require('path');
const fs = require('fs');

const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

// ---- better-sqlite3 互換ラッパー ----

function flatParams(args) {
  if (args.length === 0) return [];
  // stmt.all(...array) でスプレッドされた場合も、単一配列渡しも両方対応
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

class Statement {
  constructor(wasmStmt) {
    this._s = wasmStmt;
  }
  run(...args) {
    const result = this._s.run(flatParams(args));
    this._s.reset();
    return result;
  }
  get(...args) {
    const row = this._s.get(flatParams(args));
    this._s.reset();
    return row ?? undefined; // null → undefined に統一
  }
  all(...args) {
    return this._s.all(flatParams(args));
  }
}

class DB {
  constructor(dbPath) {
    this._db = new WasmDatabase(dbPath);
  }
  pragma(str) {
    try { this._db.exec(`PRAGMA ${str}`); } catch (_) { /* ignore */ }
    return this;
  }
  exec(sql) {
    this._db.exec(sql);
    return this;
  }
  prepare(sql) {
    return new Statement(this._db.prepare(sql));
  }
  transaction(fn) {
    const self = this;
    return function (...args) {
      self.exec('BEGIN');
      try {
        const result = fn(...args);
        self.exec('COMMIT');
        return result;
      } catch (e) {
        self.exec('ROLLBACK');
        throw e;
      }
    };
  }
}

// ---- DB 初期化 ----

const db = new DB(path.join(dbDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('fulltime','parttime','contractor')),
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft','sent','signed','cancelled')),
    employer_name TEXT,
    employer_address TEXT,
    employer_rep TEXT,
    recipient_name TEXT NOT NULL,
    recipient_email TEXT NOT NULL,
    recipient_address TEXT,
    start_date TEXT,
    end_date TEXT,
    position TEXT,
    work_location TEXT,
    work_hours TEXT,
    salary INTEGER,
    project_name TEXT,
    contract_amount INTEGER,
    payment_terms TEXT,
    deliverables TEXT,
    template_id TEXT,
    pdf_path TEXT,
    signed_pdf_path TEXT,
    sign_token TEXT UNIQUE,
    sign_expires_at TEXT,
    signer_ip TEXT,
    signature_data TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    sent_at TEXT,
    signed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK(status IN ('draft','sent','paid','cancelled')),
    issuer_name TEXT,
    issuer_address TEXT,
    issuer_phone TEXT,
    issuer_email TEXT,
    issuer_bank_name TEXT,
    issuer_bank_branch TEXT,
    issuer_bank_type TEXT,
    issuer_bank_number TEXT,
    issuer_bank_holder TEXT,
    client_name TEXT NOT NULL,
    client_email TEXT,
    client_address TEXT,
    client_dept TEXT,
    client_contact TEXT,
    issue_date TEXT,
    due_date TEXT,
    items TEXT DEFAULT '[]',
    subtotal INTEGER DEFAULT 0,
    discount INTEGER DEFAULT 0,
    tax_rate INTEGER DEFAULT 10,
    tax_amount INTEGER DEFAULT 0,
    total INTEGER DEFAULT 0,
    notes TEXT,
    pdf_path TEXT,
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

// ---- マイグレーション: contracts.type を fulltime/parttime/contractor に拡張 ----
{
  const ddlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contracts'").get();
  if (ddlRow && ddlRow.sql && ddlRow.sql.includes("'employee'")) {
    // 旧スキーマ（employee/contractor）→ 新スキーマへ移行
    db.exec(`
      CREATE TABLE IF NOT EXISTS contracts_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('fulltime','parttime','contractor')),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft','sent','signed','cancelled')),
        employer_name TEXT,
        employer_address TEXT,
        employer_rep TEXT,
        recipient_name TEXT NOT NULL,
        recipient_email TEXT NOT NULL,
        recipient_address TEXT,
        start_date TEXT,
        end_date TEXT,
        position TEXT,
        work_location TEXT,
        work_hours TEXT,
        salary INTEGER,
        project_name TEXT,
        contract_amount INTEGER,
        payment_terms TEXT,
        deliverables TEXT,
        template_id TEXT,
        pdf_path TEXT,
        signed_pdf_path TEXT,
        sign_token TEXT UNIQUE,
        sign_expires_at TEXT,
        signer_ip TEXT,
        signature_data TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        sent_at TEXT,
        signed_at TEXT
      )
    `);
    db.exec(`
      INSERT INTO contracts_new SELECT
        id,
        CASE WHEN type='employee' THEN 'fulltime' ELSE type END,
        status, employer_name, employer_address, employer_rep,
        recipient_name, recipient_email, recipient_address,
        start_date, end_date, position, work_location, work_hours, salary,
        project_name, contract_amount, payment_terms, deliverables,
        template_id, pdf_path, signed_pdf_path, sign_token, sign_expires_at,
        signer_ip, signature_data, notes, created_at, sent_at, signed_at
      FROM contracts
    `);
    db.exec('DROP TABLE contracts');
    db.exec('ALTER TABLE contracts_new RENAME TO contracts');
    console.log('DB migration: contracts.type updated (employee → fulltime)');
  }
}

// デフォルト設定（初回のみ挿入）
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

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of defaultSettings) insertSetting.run(key, value);

module.exports = db;
