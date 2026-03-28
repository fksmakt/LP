const nodemailer = require('nodemailer');

function createTransport(settings) {
  if (!settings.smtp_host || !settings.smtp_user) {
    // テスト用（Ethereal）
    return null;
  }
  return nodemailer.createTransport({
    host: settings.smtp_host,
    port: parseInt(settings.smtp_port) || 587,
    secure: parseInt(settings.smtp_port) === 465,
    auth: {
      user: settings.smtp_user,
      pass: settings.smtp_pass,
    },
  });
}

async function sendSigningRequest(settings, contract, signUrl) {
  const transport = createTransport(settings);
  const fromName = settings.smtp_from_name || settings.company_name || 'システム';
  const fromEmail = settings.smtp_from_email || settings.smtp_user;

  if (!transport) {
    console.log('[メール] SMTP未設定 - 署名URL:', signUrl);
    return { success: true, preview: signUrl };
  }

  const contractType = contract.type === 'employee' ? '労働契約書' : '業務委託契約書';
  const html = `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic',sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:#3730a3;padding:30px;text-align:center;border-radius:8px 8px 0 0;">
    <h1 style="color:white;margin:0;font-size:22px;">電子署名のお願い</h1>
  </div>
  <div style="background:white;padding:30px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
    <p>${contract.recipient_name} 様</p>
    <p>${settings.company_name || fromName}より、${contractType}の電子署名をお願い申し上げます。</p>
    <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:20px 0;">
      <p style="margin:0 0 8px;"><strong>書類種別：</strong>${contractType}</p>
      <p style="margin:0;"><strong>作成者：</strong>${settings.company_name || ''}</p>
    </div>
    <p>下記のボタンをクリックして、書類をご確認の上、電子署名をお願いいたします。</p>
    <div style="text-align:center;margin:30px 0;">
      <a href="${signUrl}"
         style="background:#3730a3;color:white;padding:16px 40px;text-decoration:none;border-radius:8px;font-size:16px;font-weight:bold;">
        書類を確認して署名する
      </a>
    </div>
    <p style="color:#6b7280;font-size:12px;">このリンクは送信から7日間有効です。</p>
    <p style="color:#6b7280;font-size:12px;">ご不明な点は <a href="mailto:${settings.company_email || fromEmail}">${settings.company_email || fromEmail}</a> までお問い合わせください。</p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin-top:20px;">
    ${settings.company_name || ''} | ${settings.company_address || ''}
  </p>
</body>
</html>`;

  const info = await transport.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: contract.recipient_email,
    subject: `【電子署名依頼】${contractType} - ${settings.company_name || ''}`,
    html,
  });
  return { success: true, messageId: info.messageId };
}

async function sendSignedNotification(settings, contract, pdfBuffer) {
  const transport = createTransport(settings);
  const fromName = settings.smtp_from_name || settings.company_name || 'システム';
  const fromEmail = settings.smtp_from_email || settings.smtp_user;
  const contractType = contract.type === 'employee' ? '労働契約書' : '業務委託契約書';

  if (!transport) {
    console.log('[メール] SMTP未設定 - 署名完了通知スキップ');
    return { success: true };
  }

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic',sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:#059669;padding:30px;text-align:center;border-radius:8px 8px 0 0;">
    <h1 style="color:white;margin:0;font-size:22px;">✓ 署名が完了しました</h1>
  </div>
  <div style="background:white;padding:30px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
    <p>${contract.recipient_name} 様が${contractType}に署名しました。</p>
    <p>署名済みの書類を添付いたします。保管をお願いいたします。</p>
  </div>
</body>
</html>`;

  // 管理者への通知
  if (settings.company_email || fromEmail) {
    await transport.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: settings.company_email || fromEmail,
      subject: `【署名完了】${contractType} - ${contract.recipient_name}`,
      html,
      attachments: pdfBuffer ? [{
        filename: `signed_${contract.id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }] : [],
    });
  }

  // 署名者への送付
  await transport.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: contract.recipient_email,
    subject: `【署名済み書類】${contractType} - ${settings.company_name || ''}`,
    html: html.replace('が署名しました', 'の署名が完了しました。書類を添付いたします'),
    attachments: pdfBuffer ? [{
      filename: `contract_${contract.id}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }] : [],
  });

  return { success: true };
}

async function sendInvoice(settings, invoice, pdfBuffer) {
  const transport = createTransport(settings);
  const fromName = settings.smtp_from_name || settings.company_name || 'システム';
  const fromEmail = settings.smtp_from_email || settings.smtp_user;

  if (!transport) {
    console.log('[メール] SMTP未設定 - 請求書メールスキップ');
    return { success: true };
  }

  const formatMoney = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');

  const html = `
<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"></head>
<body style="font-family:'Hiragino Sans','Yu Gothic',sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
  <div style="background:#3730a3;padding:30px;text-align:center;border-radius:8px 8px 0 0;">
    <h1 style="color:white;margin:0;font-size:22px;">請求書のご送付</h1>
  </div>
  <div style="background:white;padding:30px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 8px 8px;">
    <p>${invoice.client_name} 御中</p>
    <p>平素よりお世話になっております。${settings.company_name || fromName}でございます。</p>
    <p>下記の通り請求書をお送りいたします。何卒ご確認の程よろしくお願い申し上げます。</p>
    <div style="background:#f3f4f6;padding:20px;border-radius:8px;margin:20px 0;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px 0;"><strong>請求書番号</strong></td>
          <td style="padding:8px 0;">${invoice.invoice_number}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;"><strong>請求金額</strong></td>
          <td style="padding:8px 0;font-size:18px;color:#3730a3;">${formatMoney(invoice.total)}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;"><strong>お支払い期限</strong></td>
          <td style="padding:8px 0;">${invoice.due_date || '---'}</td>
        </tr>
      </table>
    </div>
    <p>請求書のPDFを添付しております。</p>
    ${settings.bank_name ? `
    <div style="background:#eff6ff;padding:15px;border-radius:8px;border-left:4px solid #3730a3;margin-top:20px;">
      <p style="margin:0 0 8px;font-weight:bold;">お振込先</p>
      <p style="margin:0;">${settings.bank_name} ${settings.bank_branch || ''}</p>
      <p style="margin:0;">${settings.bank_type || '普通'} ${settings.bank_number || ''}</p>
      <p style="margin:0;">口座名義: ${settings.bank_holder || ''}</p>
    </div>` : ''}
    <p style="color:#6b7280;font-size:12px;margin-top:20px;">ご不明な点は <a href="mailto:${settings.company_email || fromEmail}">${settings.company_email || fromEmail}</a> までご連絡ください。</p>
  </div>
  <p style="text-align:center;color:#9ca3af;font-size:11px;margin-top:20px;">
    ${settings.company_name || ''} | ${settings.company_address || ''} | ${settings.company_phone || ''}
  </p>
</body>
</html>`;

  const info = await transport.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: invoice.client_email,
    subject: `【請求書】No.${invoice.invoice_number} ${settings.company_name || fromName}`,
    html,
    attachments: pdfBuffer ? [{
      filename: `invoice_${invoice.invoice_number}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }] : [],
  });
  return { success: true, messageId: info.messageId };
}

module.exports = { sendSigningRequest, sendSignedNotification, sendInvoice };
