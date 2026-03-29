const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

// テンプレートアップロード設定
const templateStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'templates');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});
const uploadTemplate = multer({
  storage: templateStorage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('PDFファイルのみアップロード可能です'));
  },
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ロゴアップロード設定
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', 'logos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo${ext}`);
  },
});
const uploadLogo = multer({ storage: logoStorage, limits: { fileSize: 5 * 1024 * 1024 } });

// 設定取得
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  // パスワードはマスク
  if (settings.smtp_pass && settings.smtp_pass.length > 0) {
    settings.smtp_pass = '••••••••';
  }
  res.json(settings);
});

// 設定更新
router.put('/', (req, res) => {
  const allowed = [
    'company_name', 'company_address', 'company_phone', 'company_email', 'company_rep',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_from_name', 'smtp_from_email',
    'base_url', 'invoice_prefix', 'tax_rate',
    'bank_name', 'bank_branch', 'bank_type', 'bank_number', 'bank_holder',
  ];
  const update = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const updateAll = db.transaction((data) => {
    for (const key of allowed) {
      if (data[key] !== undefined) update.run(key, data[key]);
    }
  });
  updateAll(req.body);

  // パスワードは別途（空でない場合のみ更新）
  if (req.body.smtp_pass && req.body.smtp_pass !== '••••••••') {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('smtp_pass', req.body.smtp_pass);
  }

  res.json({ success: true });
});

// テンプレート一覧
router.get('/templates', (req, res) => {
  const rows = db.prepare('SELECT * FROM templates ORDER BY created_at DESC').all();
  res.json(rows);
});

// テンプレートアップロード
router.post('/templates', uploadTemplate.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルが必要です' });
    const id = uuidv4();
    db.prepare('INSERT INTO templates (id, name, type, file_path, description) VALUES (?, ?, ?, ?, ?)').run(
      id, req.body.name || req.file.originalname, req.body.type || 'employee_contract',
      req.file.path, req.body.description || ''
    );
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// テンプレート削除
router.delete('/templates/:id', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl) return res.status(404).json({ error: '見つかりません' });
  if (fs.existsSync(tmpl.file_path)) fs.unlinkSync(tmpl.file_path);
  db.prepare('DELETE FROM templates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// テンプレートダウンロード
router.get('/templates/:id/download', (req, res) => {
  const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(req.params.id);
  if (!tmpl || !fs.existsSync(tmpl.file_path)) return res.status(404).json({ error: '見つかりません' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(tmpl.name)}.pdf"`);
  res.send(fs.readFileSync(tmpl.file_path));
});

// ロゴアップロード
router.post('/logo', uploadLogo.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルが必要です' });
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('logo_path', req.file.path);
  res.json({ success: true, path: `/uploads/logos/${req.file.filename}` });
});

module.exports = router;
