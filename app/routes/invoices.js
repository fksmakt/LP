const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { generateInvoicePDF } = require('../utils/pdf');
const { sendInvoice } = require('../utils/mailer');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function nextInvoiceNumber() {
  const settings = getSettings();
  const prefix = settings.invoice_prefix || 'INV';
  const seq = parseInt(settings.next_invoice_seq || '1');
  const today = new Date();
  const ym = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}`;
  const num = `${prefix}-${ym}-${String(seq).padStart(4, '0')}`;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'next_invoice_seq'").run(seq + 1);
  return num;
}

function calcAmounts(items, discount, taxRate) {
  const subtotal = items.reduce((s, i) => s + Math.round((i.qty || 1) * (parseFloat(i.unit_price) || 0)), 0);
  const disc = Math.round(parseFloat(discount) || 0);
  const taxable = subtotal - disc;
  const taxAmount = Math.floor(taxable * (parseInt(taxRate) || 10) / 100);
  const total = taxable + taxAmount;
  return { subtotal, discount: disc, taxAmount, total };
}

// 一覧
router.get('/', (req, res) => {
  const { status, q } = req.query;
  let sql = 'SELECT * FROM invoices WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (q) { sql += ' AND (client_name LIKE ? OR invoice_number LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// 統計（/:id より前に定義すること）
router.get('/stats/summary', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM invoices').get().c;
  const draft = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='draft'").get().c;
  const sent = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='sent'").get().c;
  const paid = db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='paid'").get().c;
  const totalAmount = db.prepare("SELECT COALESCE(SUM(total),0) as s FROM invoices WHERE status != 'cancelled'").get().s;
  const unpaidAmount = db.prepare("SELECT COALESCE(SUM(total),0) as s FROM invoices WHERE status='sent'").get().s;
  res.json({ total, draft, sent, paid, totalAmount, unpaidAmount });
});

// 詳細（固有ルートの後に配置）
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '見つかりません' });
  res.json(row);
});

// 作成
router.post('/', (req, res) => {
  try {
    if (!req.body.client_name) return res.status(400).json({ error: '顧客名は必須です' });
    const items = req.body.items || [];
    if (!items.length) return res.status(400).json({ error: '明細を1件以上入力してください' });

    const taxRate = parseInt(req.body.tax_rate ?? getSettings().tax_rate ?? 10);
    const { subtotal, discount, taxAmount, total } = calcAmounts(items, req.body.discount, taxRate);

    const id = uuidv4();
    const invoice_number = nextInvoiceNumber();

    db.prepare(`
      INSERT INTO invoices (
        id, invoice_number, client_name, client_email, client_address,
        client_dept, client_contact, issue_date, due_date, items,
        subtotal, discount, tax_rate, tax_amount, total, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, invoice_number,
      req.body.client_name, req.body.client_email || null, req.body.client_address || null,
      req.body.client_dept || null, req.body.client_contact || null,
      req.body.issue_date || null, req.body.due_date || null,
      JSON.stringify(items),
      subtotal, discount, taxRate, taxAmount, total,
      req.body.notes || null
    );

    res.json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 更新（BUG FIX: client_contact の copy-paste バグを修正）
router.put('/:id', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!inv) return res.status(404).json({ error: '見つかりません' });

  const items = req.body.items || JSON.parse(inv.items || '[]');
  const taxRate = parseInt(req.body.tax_rate ?? inv.tax_rate ?? 10);
  const { subtotal, discount, taxAmount, total } = calcAmounts(items, req.body.discount ?? inv.discount, taxRate);

  db.prepare(`
    UPDATE invoices SET
      client_name = ?, client_email = ?, client_address = ?,
      client_dept = ?, client_contact = ?,
      issue_date = ?, due_date = ?, items = ?,
      subtotal = ?, discount = ?, tax_rate = ?, tax_amount = ?, total = ?,
      notes = ?
    WHERE id = ?
  `).run(
    req.body.client_name ?? inv.client_name,
    req.body.client_email ?? inv.client_email,
    req.body.client_address ?? inv.client_address,
    req.body.client_dept ?? inv.client_dept,
    req.body.client_contact ?? inv.client_contact,   // FIX: was req.body.client_email
    req.body.issue_date ?? inv.issue_date,
    req.body.due_date ?? inv.due_date,
    JSON.stringify(items),
    subtotal, discount, taxRate, taxAmount, total,
    req.body.notes ?? inv.notes,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id));
});

// PDF生成・ダウンロード
router.get('/:id/pdf', async (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ error: '見つかりません' });

    const settings = getSettings();
    const pdfBuffer = await generateInvoicePDF(invoice, settings);

    const pdfDir = path.join(__dirname, '..', 'uploads', 'invoices');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    const pdfPath = path.join(pdfDir, `${invoice.id}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);
    db.prepare('UPDATE invoices SET pdf_path = ? WHERE id = ?').run(pdfPath, invoice.id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice_${invoice.invoice_number}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// メール送信
router.post('/:id/send', async (req, res) => {
  try {
    const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
    if (!invoice) return res.status(404).json({ error: '見つかりません' });
    if (!invoice.client_email) return res.status(400).json({ error: 'クライアントのメールアドレスが未設定です' });

    const settings = getSettings();
    const pdfBuffer = await generateInvoicePDF(invoice, settings);
    const result = await sendInvoice(settings, invoice, pdfBuffer);

    db.prepare("UPDATE invoices SET status = 'sent', sent_at = datetime('now','localtime') WHERE id = ?").run(invoice.id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 入金済みにする
router.post('/:id/paid', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: '見つかりません' });
  db.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now','localtime') WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// キャンセル
router.post('/:id/cancel', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: '見つかりません' });
  db.prepare("UPDATE invoices SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// 削除
router.delete('/:id', (req, res) => {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) return res.status(404).json({ error: '見つかりません' });
  if (invoice.pdf_path && fs.existsSync(invoice.pdf_path)) fs.unlinkSync(invoice.pdf_path);
  db.prepare('DELETE FROM invoices WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
