const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// 日本語フォントのパス候補（優先順）
const JP_FONT_CANDIDATES = [
  path.join(__dirname, '..', 'fonts', 'NotoSansJP-Regular.ttf'),
  path.join(__dirname, '..', 'fonts', 'NotoSansJP-Regular.otf'),
  path.join(__dirname, '..', 'node_modules', '@fontsource', 'noto-sans-jp', 'files', 'noto-sans-jp-japanese-400-normal.woff2'),
  path.join(__dirname, '..', 'node_modules', '@fontsource', 'noto-sans-jp', 'files', 'noto-sans-jp-japanese-400-normal.woff'),
];

async function loadJpFont(pdfDoc) {
  for (const p of JP_FONT_CANDIDATES) {
    if (fs.existsSync(p)) {
      try {
        pdfDoc.registerFontkit(fontkit);
        const fontBytes = fs.readFileSync(p);
        return await pdfDoc.embedFont(fontBytes, { subset: true });
      } catch (e) {
        // 次の候補を試す
      }
    }
  }
  return await pdfDoc.embedFont(StandardFonts.Helvetica);
}

function formatDate(dateStr) {
  if (!dateStr) return '　　　　年　　月　　日';
  const d = new Date(dateStr);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatMoney(amount) {
  if (!amount && amount !== 0) return '¥0';
  return '¥' + Number(amount).toLocaleString('ja-JP');
}

// 契約書PDF生成（従業員）
async function generateEmployeeContract(contract, companySettings) {
  const pdfDoc = await PDFDocument.create();
  const font = await loadJpFont(pdfDoc);
  const boldFont = await loadJpFont(pdfDoc);

  const page = pdfDoc.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  const margin = 60;
  let y = height - margin;

  const draw = (text, x, yPos, size = 10, color = rgb(0, 0, 0)) => {
    page.drawText(text || '', { x, y: yPos, size, font, color });
  };

  const line = (x1, y1, x2, y2) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
      thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
  };

  // タイトル
  draw('労働契約書', width / 2 - 50, y, 18);
  y -= 40;

  // 契約日
  draw(`契約締結日：${formatDate(new Date().toISOString().split('T')[0])}`, margin, y, 10);
  y -= 30;

  // 当事者
  draw('甲（雇用者）', margin, y, 11);
  y -= 18;
  draw(`会社名：${companySettings.company_name || ''}`, margin + 10, y, 10);
  y -= 16;
  draw(`住所：${companySettings.company_address || ''}`, margin + 10, y, 10);
  y -= 16;
  draw(`代表者：${companySettings.company_rep || ''}`, margin + 10, y, 10);
  y -= 25;

  draw('乙（労働者）', margin, y, 11);
  y -= 18;
  draw(`氏名：${contract.recipient_name || ''}`, margin + 10, y, 10);
  y -= 16;
  draw(`住所：${contract.recipient_address || ''}`, margin + 10, y, 10);
  y -= 25;

  line(margin, y, width - margin, y);
  y -= 20;

  // 契約内容
  const sections = [
    { title: '第1条（雇用期間）', content: [
      `雇用開始日：${formatDate(contract.start_date)}`,
      contract.end_date ? `雇用終了日：${formatDate(contract.end_date)}` : '期間の定め：なし（無期雇用）',
    ]},
    { title: '第2条（職種・業務内容）', content: [
      `職種：${contract.position || ''}`,
      `就業場所：${contract.work_location || ''}`,
    ]},
    { title: '第3条（労働時間・休日）', content: [
      `労働時間：${contract.work_hours || '所定労働時間に準ずる'}`,
    ]},
    { title: '第4条（賃金）', content: [
      `月額基本給：${formatMoney(contract.salary)}（税込）`,
      '支払日：毎月末日締め、翌月25日払い',
    ]},
  ];

  for (const sec of sections) {
    if (y < 120) {
      const newPage = pdfDoc.addPage([595, 842]);
      y = newPage.getSize().height - margin;
    }
    draw(sec.title, margin, y, 11);
    y -= 18;
    for (const c of sec.content) {
      draw(c, margin + 10, y, 10);
      y -= 16;
    }
    y -= 10;
  }

  // 備考
  if (contract.notes) {
    draw('【備考】', margin, y, 11);
    y -= 18;
    draw(contract.notes, margin + 10, y, 10);
    y -= 30;
  }

  // 署名欄
  if (y < 180) {
    pdfDoc.addPage([595, 842]);
    y = 842 - margin;
  }
  y -= 20;
  line(margin, y, width - margin, y);
  y -= 20;
  draw('以上の内容に同意し、本契約を締結します。', margin, y, 10);
  y -= 35;

  // 甲署名欄
  draw('甲（雇用者）署名：', margin, y, 10);
  line(margin + 90, y - 3, margin + 300, y - 3);
  draw('日付：', margin + 310, y, 10);
  line(margin + 340, y - 3, width - margin, y - 3);
  y -= 50;

  // 乙署名欄
  draw('乙（労働者）署名：', margin, y, 10);
  line(margin + 90, y - 3, margin + 300, y - 3);
  draw('日付：', margin + 310, y, 10);
  line(margin + 340, y - 3, width - margin, y - 3);

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

// 業務委託契約書PDF生成
async function generateContractorContract(contract, companySettings) {
  const pdfDoc = await PDFDocument.create();
  const font = await loadJpFont(pdfDoc);

  const page = pdfDoc.addPage([595, 842]);
  const { width, height } = page.getSize();
  const margin = 60;
  let y = height - margin;

  const draw = (text, x, yPos, size = 10) => {
    page.drawText(text || '', { x, y: yPos, size, font, color: rgb(0, 0, 0) });
  };
  const line = (x1, y1, x2, y2) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
      thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
  };

  draw('業務委託契約書', width / 2 - 60, y, 18);
  y -= 40;
  draw(`契約締結日：${formatDate(new Date().toISOString().split('T')[0])}`, margin, y, 10);
  y -= 30;

  draw('委託者（甲）', margin, y, 11); y -= 18;
  draw(`会社名：${companySettings.company_name || ''}`, margin + 10, y, 10); y -= 16;
  draw(`住所：${companySettings.company_address || ''}`, margin + 10, y, 10); y -= 16;
  draw(`代表者：${companySettings.company_rep || ''}`, margin + 10, y, 10); y -= 25;

  draw('受託者（乙）', margin, y, 11); y -= 18;
  draw(`氏名・会社名：${contract.recipient_name || ''}`, margin + 10, y, 10); y -= 16;
  draw(`住所：${contract.recipient_address || ''}`, margin + 10, y, 10); y -= 25;

  line(margin, y, width - margin, y); y -= 20;

  const sections = [
    { title: '第1条（業務内容）', content: [
      `業務名：${contract.project_name || ''}`,
      `成果物：${contract.deliverables || '別途協議による'}`,
    ]},
    { title: '第2条（委託期間）', content: [
      `開始日：${formatDate(contract.start_date)}`,
      `終了日：${contract.end_date ? formatDate(contract.end_date) : '業務完了まで'}`,
    ]},
    { title: '第3条（報酬）', content: [
      `委託報酬：${formatMoney(contract.contract_amount)}（税別）`,
      `支払条件：${contract.payment_terms || '業務完了後30日以内'}`,
    ]},
    { title: '第4条（守秘義務）', content: [
      '受託者は業務上知り得た情報を第三者に漏洩してはならない。',
      '本条の義務は契約終了後も3年間継続する。',
    ]},
    { title: '第5条（著作権・知的財産権）', content: [
      '本業務の成果物に関する著作権は甲に帰属する。',
    ]},
  ];

  for (const sec of sections) {
    if (y < 120) {
      pdfDoc.addPage([595, 842]);
      y = 842 - margin;
    }
    draw(sec.title, margin, y, 11); y -= 18;
    for (const c of sec.content) {
      draw(c, margin + 10, y, 10); y -= 16;
    }
    y -= 10;
  }

  if (contract.notes) {
    draw('【備考・特記事項】', margin, y, 11); y -= 18;
    draw(contract.notes, margin + 10, y, 10); y -= 30;
  }

  if (y < 180) { pdfDoc.addPage([595, 842]); y = 842 - margin; }
  y -= 20;
  line(margin, y, width - margin, y); y -= 20;
  draw('以上の内容に同意し、本契約を締結します。', margin, y, 10); y -= 35;

  draw('甲（委託者）署名：', margin, y, 10);
  line(margin + 90, y - 3, margin + 300, y - 3);
  draw('日付：', margin + 310, y, 10);
  line(margin + 340, y - 3, width - margin, y - 3);
  y -= 50;

  draw('乙（受託者）署名：', margin, y, 10);
  line(margin + 90, y - 3, margin + 300, y - 3);
  draw('日付：', margin + 310, y, 10);
  line(margin + 340, y - 3, width - margin, y - 3);

  return Buffer.from(await pdfDoc.save());
}

// 契約書に署名を埋め込む
async function embedSignature(pdfPath, signatureDataUrl, signerName, signedAt) {
  const existingBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(existingBytes);
  const font = await loadJpFont(pdfDoc);

  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const { width, height } = lastPage.getSize();

  // 署名画像を埋め込む
  if (signatureDataUrl && signatureDataUrl.startsWith('data:image/png')) {
    const base64 = signatureDataUrl.replace(/^data:image\/png;base64,/, '');
    const pngBytes = Buffer.from(base64, 'base64');
    const pngImage = await pdfDoc.embedPng(pngBytes);
    const imgWidth = 180;
    const imgHeight = 60;
    lastPage.drawImage(pngImage, {
      x: 60 + 90,
      y: height - 820,
      width: imgWidth,
      height: imgHeight,
    });
  }

  // 署名済みスタンプ
  const stamped = signerName ? `電子署名済み: ${signerName}　${signedAt}` : `署名日時: ${signedAt}`;
  lastPage.drawText(stamped, {
    x: 60,
    y: 20,
    size: 8,
    font,
    color: rgb(0.4, 0.4, 0.4),
  });

  return Buffer.from(await pdfDoc.save());
}

// 請求書PDF生成
async function generateInvoicePDF(invoice, companySettings) {
  const pdfDoc = await PDFDocument.create();
  const font = await loadJpFont(pdfDoc);

  const page = pdfDoc.addPage([595, 842]);
  const { width, height } = page.getSize();
  const margin = 50;
  let y = height - margin;

  const draw = (text, x, yPos, size = 10, color = rgb(0, 0, 0)) => {
    page.drawText(String(text || ''), { x, y: yPos, size, font, color });
  };
  const rect = (x, y, w, h, fillColor) => {
    page.drawRectangle({ x, y, width: w, height: h, color: fillColor });
  };
  const line = (x1, y1, x2, y2, thickness = 0.5) => {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
      thickness, color: rgb(0.7, 0.7, 0.7) });
  };

  // ヘッダー背景
  rect(0, height - 80, width, 80, rgb(0.2, 0.27, 0.9));
  draw('請　求　書', margin, height - 52, 22, rgb(1, 1, 1));
  draw(`No. ${invoice.invoice_number}`, width - 180, height - 45, 11, rgb(0.9, 0.9, 1));
  draw(`発行日: ${formatDate(invoice.issue_date)}`, width - 180, height - 62, 9, rgb(0.9, 0.9, 1));

  y = height - 100;

  // 請求先
  draw('請求先', margin, y, 9, rgb(0.5, 0.5, 0.5)); y -= 16;
  draw(`${invoice.client_name} 御中`, margin, y, 13); y -= 16;
  if (invoice.client_dept) { draw(invoice.client_dept, margin, y, 10); y -= 14; }
  if (invoice.client_contact) { draw(`担当: ${invoice.client_contact}`, margin, y, 10); y -= 14; }
  if (invoice.client_address) { draw(invoice.client_address, margin, y, 9, rgb(0.4, 0.4, 0.4)); }

  // 発行者（右側）
  const rx = width / 2 + 20;
  let ry = height - 100;
  draw('発行者', rx, ry, 9, rgb(0.5, 0.5, 0.5)); ry -= 16;
  draw(companySettings.company_name || invoice.issuer_name || '', rx, ry, 12); ry -= 16;
  if (companySettings.company_address || invoice.issuer_address) {
    draw(companySettings.company_address || invoice.issuer_address, rx, ry, 9, rgb(0.4, 0.4, 0.4)); ry -= 14;
  }
  if (companySettings.company_phone || invoice.issuer_phone) {
    draw(`TEL: ${companySettings.company_phone || invoice.issuer_phone}`, rx, ry, 9); ry -= 14;
  }
  if (companySettings.company_email || invoice.issuer_email) {
    draw(companySettings.company_email || invoice.issuer_email, rx, ry, 9); ry -= 14;
  }

  y = Math.min(y - 20, ry - 20);
  line(margin, y, width - margin, y); y -= 20;

  // お支払い期限と合計
  draw(`お支払い期限：${formatDate(invoice.due_date)}`, margin, y, 10); y -= 16;
  draw('ご請求金額', margin, y, 11);
  const totalStr = formatMoney(invoice.total);
  draw(totalStr, margin + 70, y, 14, rgb(0.15, 0.15, 0.75));
  y -= 30;

  // 明細テーブルヘッダー
  rect(margin, y - 4, width - margin * 2, 20, rgb(0.2, 0.27, 0.9));
  draw('品目・内容', margin + 5, y + 2, 9, rgb(1, 1, 1));
  draw('数量', width - 250, y + 2, 9, rgb(1, 1, 1));
  draw('単価', width - 200, y + 2, 9, rgb(1, 1, 1));
  draw('金額', width - 130, y + 2, 9, rgb(1, 1, 1));
  y -= 24;

  // 明細
  const items = JSON.parse(invoice.items || '[]');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i % 2 === 1) rect(margin, y - 4, width - margin * 2, 18, rgb(0.97, 0.97, 0.97));
    draw(item.name || '', margin + 5, y, 9);
    draw(String(item.qty || 1), width - 250, y, 9);
    draw(formatMoney(item.unit_price), width - 200, y, 9);
    draw(formatMoney((item.qty || 1) * (item.unit_price || 0)), width - 130, y, 9);
    y -= 18;
    line(margin, y, width - margin, y);
  }

  y -= 10;

  // 合計欄
  const summaryX = width / 2 + 20;
  line(summaryX, y, width - margin, y); y -= 18;
  draw('小計', summaryX + 5, y, 10);
  draw(formatMoney(invoice.subtotal), width - 130, y, 10); y -= 18;

  if (invoice.discount > 0) {
    draw('値引き', summaryX + 5, y, 10);
    draw('-' + formatMoney(invoice.discount), width - 130, y, 10, rgb(0.8, 0.1, 0.1)); y -= 18;
  }

  draw(`消費税（${invoice.tax_rate}%）`, summaryX + 5, y, 10);
  draw(formatMoney(invoice.tax_amount), width - 130, y, 10); y -= 4;
  line(summaryX, y, width - margin, y); y -= 20;

  rect(summaryX, y - 4, width - margin - summaryX, 22, rgb(0.2, 0.27, 0.9));
  draw('合計金額', summaryX + 5, y + 3, 11, rgb(1, 1, 1));
  draw(formatMoney(invoice.total), width - 145, y + 3, 11, rgb(1, 1, 1));
  y -= 35;

  // 銀行振込先
  const bankName = companySettings.bank_name || invoice.issuer_bank_name;
  if (bankName) {
    line(margin, y, width - margin, y); y -= 18;
    draw('【お振込先】', margin, y, 10); y -= 16;
    draw(`${bankName} ${companySettings.bank_branch || ''} ${companySettings.bank_type || '普通'} ${companySettings.bank_number || ''}`, margin + 10, y, 10); y -= 14;
    draw(`口座名義: ${companySettings.bank_holder || ''}`, margin + 10, y, 10); y -= 20;
  }

  // 備考
  if (invoice.notes) {
    line(margin, y, width - margin, y); y -= 18;
    draw('備考', margin, y, 10); y -= 14;
    draw(invoice.notes, margin + 10, y, 9, rgb(0.3, 0.3, 0.3));
  }

  // フッター
  draw('このたびはご利用いただきありがとうございます。上記のとおりご請求申し上げます。', margin, 40, 8, rgb(0.5, 0.5, 0.5));

  return Buffer.from(await pdfDoc.save());
}

// テンプレートPDFに署名を追加する
async function addSignatureToTemplate(templatePath, signatureDataUrl, contractData, signerName, signedAt) {
  const templateBytes = fs.readFileSync(templatePath);
  const pdfDoc = await PDFDocument.load(templateBytes);
  const font = await loadJpFont(pdfDoc);
  const pages = pdfDoc.getPages();
  const lastPage = pages[pages.length - 1];
  const { width, height } = lastPage.getSize();

  if (signatureDataUrl && signatureDataUrl.startsWith('data:image/png')) {
    const base64 = signatureDataUrl.replace(/^data:image\/png;base64,/, '');
    const pngBytes = Buffer.from(base64, 'base64');
    const pngImage = await pdfDoc.embedPng(pngBytes);
    lastPage.drawImage(pngImage, {
      x: 150, y: 80, width: 200, height: 60,
    });
  }

  lastPage.drawText(`電子署名済み: ${signerName}  ${signedAt}`, {
    x: 50, y: 20, size: 8, font,
    color: rgb(0.4, 0.4, 0.4),
  });

  return Buffer.from(await pdfDoc.save());
}

module.exports = {
  generateEmployeeContract,
  generateContractorContract,
  embedSignature,
  addSignatureToTemplate,
  generateInvoicePDF,
};
