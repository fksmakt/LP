const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { generateEmployeeContract, generateContractorContract, embedSignature } = require('../utils/pdf');
const { sendSigningRequest } = require('../utils/mailer');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// 一覧取得
router.get('/', (req, res) => {
  const { type, status, q } = req.query;
  let sql = 'SELECT * FROM contracts WHERE 1=1';
  const params = [];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (q) { sql += ' AND (recipient_name LIKE ? OR recipient_email LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// 統計（/:id より前に定義すること）
router.get('/stats/summary', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM contracts').get().c;
  const draft = db.prepare("SELECT COUNT(*) as c FROM contracts WHERE status='draft'").get().c;
  const sent = db.prepare("SELECT COUNT(*) as c FROM contracts WHERE status='sent'").get().c;
  const signed = db.prepare("SELECT COUNT(*) as c FROM contracts WHERE status='signed'").get().c;
  res.json({ total, draft, sent, signed });
});

// 詳細取得（固有ルートの後に配置）
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '見つかりません' });
  res.json(row);
});

// 作成
router.post('/', async (req, res) => {
  try {
    const {
      type, recipient_name, recipient_email, recipient_address,
      start_date, end_date, position, work_location, work_hours, salary,
      project_name, contract_amount, payment_terms, deliverables, notes,
      template_id,
    } = req.body;

    if (!type || !['employee', 'contractor'].includes(type)) {
      return res.status(400).json({ error: '契約種別が無効です' });
    }
    if (!recipient_name) return res.status(400).json({ error: '氏名は必須です' });
    if (!recipient_email) return res.status(400).json({ error: 'メールアドレスは必須です' });

    const id = uuidv4();
    db.prepare(`
      INSERT INTO contracts (
        id, type, recipient_name, recipient_email, recipient_address,
        start_date, end_date, position, work_location, work_hours, salary,
        project_name, contract_amount, payment_terms, deliverables, notes, template_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, type, recipient_name, recipient_email, recipient_address,
      start_date || null, end_date || null, position, work_location, work_hours,
      salary ? parseInt(salary) : null,
      project_name, contract_amount ? parseInt(contract_amount) : null,
      payment_terms, deliverables, notes, template_id || null
    );

    res.json(db.prepare('SELECT * FROM contracts WHERE id = ?').get(id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 更新（BUG FIX: updates配列に値を混入させない）
router.put('/:id', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: '見つかりません' });

  const fields = ['recipient_name', 'recipient_email', 'recipient_address',
    'start_date', 'end_date', 'position', 'work_location', 'work_hours', 'salary',
    'project_name', 'contract_amount', 'payment_terms', 'deliverables', 'notes', 'template_id'];

  const setClauses = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      setClauses.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (!setClauses.length) return res.json(contract);
  values.push(req.params.id);
  db.prepare(`UPDATE contracts SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id));
});

// PDF生成・ダウンロード
router.get('/:id/pdf', async (req, res) => {
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
    if (!contract) return res.status(404).json({ error: '見つかりません' });

    const settings = getSettings();

    if (contract.template_id) {
      const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(contract.template_id);
      if (tmpl && fs.existsSync(tmpl.file_path)) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="contract_${contract.id}.pdf"`);
        return res.send(fs.readFileSync(tmpl.file_path));
      }
    }

    let pdfBuffer;
    if (contract.type === 'employee') {
      pdfBuffer = await generateEmployeeContract(contract, settings);
    } else {
      pdfBuffer = await generateContractorContract(contract, settings);
    }

    const pdfDir = path.join(__dirname, '..', 'uploads', 'contracts');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    const pdfPath = path.join(pdfDir, `${contract.id}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);
    db.prepare('UPDATE contracts SET pdf_path = ? WHERE id = ?').run(pdfPath, contract.id);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="contract_${contract.id}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 署名用リンク送信
router.post('/:id/send', async (req, res) => {
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
    if (!contract) return res.status(404).json({ error: '見つかりません' });
    if (contract.status === 'signed') return res.status(400).json({ error: 'すでに署名済みです' });
    if (contract.status === 'cancelled') return res.status(400).json({ error: 'キャンセル済みの契約です' });

    const token = uuidv4();
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    db.prepare(`
      UPDATE contracts SET sign_token = ?, sign_expires_at = ?, status = 'sent', sent_at = datetime('now','localtime')
      WHERE id = ?
    `).run(token, expires, contract.id);

    const settings = getSettings();
    const baseUrl = settings.base_url || 'http://localhost:3000';
    const signUrl = `${baseUrl}/sign/${token}`;

    const result = await sendSigningRequest(settings, contract, signUrl);
    res.json({ success: true, signUrl, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 署名済みPDFダウンロード
router.get('/:id/signed-pdf', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: '見つかりません' });
  if (!contract.signed_pdf_path || !fs.existsSync(contract.signed_pdf_path)) {
    return res.status(404).json({ error: '署名済みPDFが見つかりません' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="signed_contract_${contract.id}.pdf"`);
  res.send(fs.readFileSync(contract.signed_pdf_path));
});

// キャンセル
router.post('/:id/cancel', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: '見つかりません' });
  db.prepare("UPDATE contracts SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// 削除
router.delete('/:id', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).json({ error: '見つかりません' });
  // 関連ファイルを削除
  if (contract.pdf_path && fs.existsSync(contract.pdf_path)) fs.unlinkSync(contract.pdf_path);
  if (contract.signed_pdf_path && fs.existsSync(contract.signed_pdf_path)) fs.unlinkSync(contract.signed_pdf_path);
  db.prepare('DELETE FROM contracts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
