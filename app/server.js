require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();

// ディレクトリ確認
const dirs = ['uploads/contracts', 'uploads/signed', 'uploads/templates', 'uploads/logos', 'fonts', 'data'];
for (const d of dirs) {
  const full = path.join(__dirname, d);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
}

// ミドルウェア
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 静的ファイル
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// APIルート
app.use('/api/contracts', require('./routes/contracts'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/settings', require('./routes/settings'));

// 署名ページ（publicのsign.htmlを返すのはsign.jsが担当）
app.use('/sign', require('./routes/sign'));

// ダッシュボードのデータ
app.get('/api/dashboard', (req, res) => {
  const db = require('./db');
  const contracts = {
    total: db.prepare('SELECT COUNT(*) as c FROM contracts').get().c,
    draft: db.prepare("SELECT COUNT(*) as c FROM contracts WHERE status='draft'").get().c,
    sent: db.prepare("SELECT COUNT(*) as c FROM contracts WHERE status='sent'").get().c,
    signed: db.prepare("SELECT COUNT(*) as c FROM contracts WHERE status='signed'").get().c,
  };
  const invoices = {
    total: db.prepare('SELECT COUNT(*) as c FROM invoices').get().c,
    draft: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='draft'").get().c,
    sent: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='sent'").get().c,
    paid: db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='paid'").get().c,
    totalAmount: db.prepare("SELECT COALESCE(SUM(total),0) as s FROM invoices WHERE status != 'cancelled'").get().s,
    unpaidAmount: db.prepare("SELECT COALESCE(SUM(total),0) as s FROM invoices WHERE status='sent'").get().s,
  };

  // 最近の契約・請求書
  const recentContracts = db.prepare(
    "SELECT id, type, status, recipient_name, created_at FROM contracts ORDER BY created_at DESC LIMIT 5"
  ).all();
  const recentInvoices = db.prepare(
    "SELECT id, invoice_number, status, client_name, total, created_at FROM invoices ORDER BY created_at DESC LIMIT 5"
  ).all();

  res.json({ contracts, invoices, recentContracts, recentInvoices });
});

// SPA フォールバック
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  契約書・請求書管理システム 起動完了');
  console.log(`  URL: http://localhost:${PORT}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
});
