import fs from 'fs';
import pdf from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Supabase クライアントの初期化
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// PDFファイルのパス
const pdfPath = '/Users/yoshito/Desktop/会社規約.pdf';

// PDFを読み込んでテキスト抽出
async function extractPdfText() {
  try {
    const dataBuffer = fs.readFileSync(pdfPath);
    const data = await pdf(dataBuffer);
    
    console.log('PDFテキスト抽出完了');
    console.log('ページ数:', data.numpages);
    console.log('テキスト長:', data.text.length);
    console.log('\n--- 抽出されたテキスト（最初の500文字）---');
    console.log(data.text.substring(0, 500));
    console.log('\n--- テキスト終了 ---\n');
    
    return data.text;
  } catch (error) {
    console.error('PDF読み込みエラー:', error);
    throw error;
  }
}

// テキストをチャンクに分割
function splitIntoChunks(text, chunkSize = 1000) {
  const chunks = [];
  const lines = text.split('\n');
  let currentChunk = '';
  
  for (const line of lines) {
    if ((currentChunk + line).length > chunkSize && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = line;
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }
  
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  
  return chunks;
}

// Supabaseにアップロード
async function uploadToSupabase(text) {
  try {
    // テキストをチャンクに分割
    const chunks = splitIntoChunks(text, 1500);
    console.log(`テキストを${chunks.length}個のチャンクに分割しました`);
    
    // 各チャンクをSupabaseに保存
    for (let i = 0; i < chunks.length; i++) {
      const { data, error } = await supabase
        .from('company_rules')
        .insert({
          title: `会社規約 - 部分${i + 1}`,
          content: chunks[i],
          category: '会社規約',
        });
      
      if (error) {
        console.error(`チャンク${i + 1}のアップロードエラー:`, error);
      } else {
        console.log(`✅ チャンク${i + 1}/${chunks.length} アップロード成功`);
      }
    }
    
    console.log('\n🎉 すべてのデータのアップロードが完了しました！');
  } catch (error) {
    console.error('Supabaseアップロードエラー:', error);
    throw error;
  }
}

// メイン処理
async function main() {
  console.log('=== PDF抽出・アップロードスクリプト開始 ===\n');
  
  // 1. PDFからテキスト抽出
  const text = await extractPdfText();
  
  // 2. Supabaseにアップロード
  await uploadToSupabase(text);
  
  console.log('\n=== 処理完了 ===');
}

main().catch(console.error);

