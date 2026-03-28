/**
 * セットアップスクリプト
 * - 必要なディレクトリを作成
 * - 日本語フォントをダウンロード（pdf-lib 用）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const dirs = [
  'data', 'fonts',
  'uploads/contracts', 'uploads/signed',
  'uploads/templates', 'uploads/logos',
  'public',
];

for (const d of dirs) {
  const full = path.join(__dirname, d);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
    console.log(`作成: ${d}`);
  }
}

// .env ファイルがなければサンプルをコピー
const envPath = path.join(__dirname, '.env');
const envExample = path.join(__dirname, '.env.example');
if (!fs.existsSync(envPath) && fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, envPath);
  console.log('.env ファイルを作成しました。設定を行ってください。');
}

// 日本語フォントのダウンロード
const fontPath = path.join(__dirname, 'fonts', 'NotoSansJP-Regular.ttf');
if (!fs.existsSync(fontPath)) {
  console.log('日本語フォントをダウンロード中...');
  // GitHub の noto-cjk から取得
  const fontUrl = 'https://github.com/googlefonts/noto-cjk/raw/main/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf';
  // 代替: Google Fonts API
  const altUrl = 'https://fonts.gstatic.com/s/notosansjp/v52/-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFBEj75vY0rw-oME.woff2';

  // フォールバック: フォントがなくても動作するが日本語は表示されない
  console.log('注意: 日本語フォントのダウンロードに失敗した場合、PDFの日本語表示が正しくない場合があります。');
  console.log('手動でNotoSansJP-Regular.ttfをfonts/ディレクトリに配置してください。');
  console.log('ダウンロード先: https://fonts.google.com/noto/specimen/Noto+Sans+JP');

  // wgetやcurlでダウンロードを試みる
  const { execSync } = require('child_process');
  try {
    // Google Fonts から woff2 を取得する代わりに、公開URLからttfを取得
    execSync(`curl -L -o "${fontPath}" "https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/OTF/Subset/NotoSansCJK-VF.otf.ttc" 2>/dev/null || true`, { timeout: 30000 });
    if (fs.existsSync(fontPath) && fs.statSync(fontPath).size > 100000) {
      console.log('フォントのダウンロード完了');
    } else {
      if (fs.existsSync(fontPath)) fs.unlinkSync(fontPath);
      console.log('フォントダウンロードをスキップ（手動配置が必要です）');
    }
  } catch (e) {
    console.log('フォントダウンロードをスキップ');
  }
}

console.log('\nセットアップ完了！');
console.log('起動: node server.js');
console.log('URL: http://localhost:3000');
