const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const {
  generateFulltimeContract,
  generateParttimeContract,
  generateContractorContract,
  embedSignature,
  addSignatureToTemplate,
} = require('../utils/pdf');
const { sendSignedNotification } = require('../utils/mailer');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.ip ||
    'unknown'
  );
}

// APIルートを先に定義（/:token が /api を誤キャッチしないよう）
// トークンから契約情報取得
router.get('/api/:token', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
  if (!contract) return res.status(404).json({ error: '無効なリンクです' });
  if (contract.status === 'signed') return res.status(410).json({ error: 'この書類はすでに署名済みです' });
  if (contract.status === 'cancelled') return res.status(410).json({ error: 'この書類はキャンセルされました' });

  const expires = new Date(contract.sign_expires_at);
  if (expires < new Date()) return res.status(410).json({ error: 'このリンクは有効期限切れです（7日間有効）' });

  const settings = getSettings();
  res.json({
    id: contract.id,
    type: contract.type,
    recipient_name: contract.recipient_name,
    employer_name: settings.company_name || contract.employer_name,
    position: contract.position,
    start_date: contract.start_date,
    end_date: contract.end_date,
    salary: contract.salary,
    project_name: contract.project_name,
    contract_amount: contract.contract_amount,
    work_location: contract.work_location,
    payment_terms: contract.payment_terms,
  });
});

// PDF取得（署名前プレビュー用）
router.get('/api/:token/pdf', async (req, res) => {
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
    if (!contract) return res.status(404).json({ error: '無効なリンクです' });

    const settings = getSettings();

    if (contract.pdf_path && fs.existsSync(contract.pdf_path)) {
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(fs.readFileSync(contract.pdf_path));
    }

    if (contract.template_id) {
      const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(contract.template_id);
      if (tmpl && fs.existsSync(tmpl.file_path)) {
        res.setHeader('Content-Type', 'application/pdf');
        return res.send(fs.readFileSync(tmpl.file_path));
      }
    }

    let pdfBuffer;
    if (contract.type === 'fulltime') {
      pdfBuffer = await generateFulltimeContract(contract, settings);
    } else if (contract.type === 'parttime') {
      pdfBuffer = await generateParttimeContract(contract, settings);
    } else {
      pdfBuffer = await generateContractorContract(contract, settings);
    }

    const pdfDir = path.join(__dirname, '..', 'uploads', 'contracts');
    if (!fs.existsSync(pdfDir)) fs.mkdirSync(pdfDir, { recursive: true });
    const pdfPath = path.join(pdfDir, `${contract.id}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);
    db.prepare('UPDATE contracts SET pdf_path = ? WHERE id = ?').run(pdfPath, contract.id);

    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 署名提出
router.post('/api/:token/submit', async (req, res) => {
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
    if (!contract) return res.status(404).json({ error: '無効なリンクです' });
    if (contract.status === 'signed') return res.status(410).json({ error: 'すでに署名済みです' });
    if (contract.status === 'cancelled') return res.status(410).json({ error: 'キャンセルされた書類です' });

    const expires = new Date(contract.sign_expires_at);
    if (expires < new Date()) return res.status(410).json({ error: 'リンクの有効期限が切れています' });

    const { signatureData, agreed } = req.body;
    if (!agreed) return res.status(400).json({ error: '利用規約に同意してください' });
    if (!signatureData || !signatureData.startsWith('data:image/')) {
      return res.status(400).json({ error: '署名データが無効です' });
    }

    const settings = getSettings();
    const signedAt = new Date().toLocaleString('ja-JP');
    const signerIp = getClientIp(req);

    const signedDir = path.join(__dirname, '..', 'uploads', 'signed');
    if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });

    let pdfBuffer;
    const pdfPath = contract.pdf_path;

    if (pdfPath && fs.existsSync(pdfPath)) {
      pdfBuffer = await embedSignature(pdfPath, signatureData, contract.recipient_name, signedAt);
    } else if (contract.template_id) {
      const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(contract.template_id);
      if (tmpl && fs.existsSync(tmpl.file_path)) {
        pdfBuffer = await addSignatureToTemplate(
          tmpl.file_path, signatureData, contract, contract.recipient_name, signedAt
        );
      }
    }

    if (!pdfBuffer) {
      // ベースPDFを生成してから署名を埋め込む
      let basePdf;
      if (contract.type === 'fulltime') {
        basePdf = await generateFulltimeContract(contract, settings);
      } else if (contract.type === 'parttime') {
        basePdf = await generateParttimeContract(contract, settings);
      } else {
        basePdf = await generateContractorContract(contract, settings);
      }
      const tmpPath = path.join(signedDir, `tmp_${contract.id}.pdf`);
      try {
        fs.writeFileSync(tmpPath, basePdf);
        pdfBuffer = await embedSignature(tmpPath, signatureData, contract.recipient_name, signedAt);
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      }
    }

    const signedPath = path.join(signedDir, `signed_${contract.id}.pdf`);
    fs.writeFileSync(signedPath, pdfBuffer);

    // 署名データはサイズが大きいのでDBには格納しない（PDFに埋め込み済み）
    db.prepare(`
      UPDATE contracts SET
        status = 'signed',
        signed_pdf_path = ?,
        signature_data = 'provided',
        signer_ip = ?,
        signed_at = datetime('now','localtime')
      WHERE id = ?
    `).run(signedPath, signerIp, contract.id);

    // メール通知（非同期、エラーは無視）
    sendSignedNotification(settings, contract, pdfBuffer).catch(err => {
      console.error('署名通知メール送信エラー:', err.message);
    });

    res.json({ success: true, message: '署名が完了しました' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 署名ページのHTML（APIルートの後に定義）
router.get('/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'sign.html'));
});

module.exports = router;
