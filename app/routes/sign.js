const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const {
  generateEmployeeContract,
  generateContractorContract,
  embedSignature,
  addSignatureToTemplate,
} = require('../utils/pdf');
const { sendSignedNotification } = require('../utils/mailer');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

// 署名ページのルート (HTMLはpublicから提供)
router.get('/:token', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'sign.html'));
});

// トークンから契約情報取得
router.get('/api/:token', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
  if (!contract) return res.status(404).json({ error: '無効なリンクです' });
  if (contract.status === 'signed') return res.status(410).json({ error: 'この書類はすでに署名済みです' });
  if (contract.status === 'cancelled') return res.status(410).json({ error: 'この書類はキャンセルされました' });

  const expires = new Date(contract.sign_expires_at);
  if (expires < new Date()) return res.status(410).json({ error: 'このリンクは有効期限切れです' });

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
  });
});

// PDF取得（署名前プレビュー用）
router.get('/api/:token/pdf', async (req, res) => {
  try {
    const contract = db.prepare('SELECT * FROM contracts WHERE sign_token = ?').get(req.params.token);
    if (!contract) return res.status(404).json({ error: '無効なリンクです' });

    const settings = getSettings();

    // 既存PDFがあれば返す
    if (contract.pdf_path && fs.existsSync(contract.pdf_path)) {
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(fs.readFileSync(contract.pdf_path));
    }

    // テンプレートがある場合
    if (contract.template_id) {
      const tmpl = db.prepare('SELECT * FROM templates WHERE id = ?').get(contract.template_id);
      if (tmpl && fs.existsSync(tmpl.file_path)) {
        res.setHeader('Content-Type', 'application/pdf');
        return res.send(fs.readFileSync(tmpl.file_path));
      }
    }

    let pdfBuffer;
    if (contract.type === 'employee') {
      pdfBuffer = await generateEmployeeContract(contract, settings);
    } else {
      pdfBuffer = await generateContractorContract(contract, settings);
    }

    // 保存
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

    const expires = new Date(contract.sign_expires_at);
    if (expires < new Date()) return res.status(410).json({ error: 'リンクの有効期限が切れています' });

    const { signatureData, agreed } = req.body;
    if (!agreed) return res.status(400).json({ error: '利用規約に同意してください' });
    if (!signatureData) return res.status(400).json({ error: '署名が必要です' });

    const settings = getSettings();
    const signedAt = new Date().toLocaleString('ja-JP');
    const signerIp = req.ip;

    // 署名済みPDF生成
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
      // 新規生成してから署名
      let basePdf;
      if (contract.type === 'employee') {
        basePdf = await generateEmployeeContract(contract, settings);
      } else {
        basePdf = await generateContractorContract(contract, settings);
      }
      const tmpPath = path.join(signedDir, `tmp_${contract.id}.pdf`);
      fs.writeFileSync(tmpPath, basePdf);
      pdfBuffer = await embedSignature(tmpPath, signatureData, contract.recipient_name, signedAt);
      fs.unlinkSync(tmpPath);
    }

    const signedPath = path.join(signedDir, `signed_${contract.id}.pdf`);
    fs.writeFileSync(signedPath, pdfBuffer);

    db.prepare(`
      UPDATE contracts SET
        status = 'signed',
        signed_pdf_path = ?,
        signature_data = ?,
        signer_ip = ?,
        signed_at = datetime('now','localtime')
      WHERE id = ?
    `).run(signedPath, signatureData.substring(0, 100), signerIp, contract.id);

    // メール通知（非同期）
    sendSignedNotification(settings, contract, pdfBuffer).catch(console.error);

    res.json({ success: true, message: '署名が完了しました' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
