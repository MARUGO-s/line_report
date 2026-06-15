# 全店舗売上スプレッドシートの毎日バックアップ（Google Apps Script）

連携している「全店舗売上」スプレッドシートを、**毎朝6時の同期の直後**に**日付名でコピー**し、専用フォルダに保存する手順です。
バックアップは **GAS（スプレッドシートの所有者の権限）** で動くので、Driveの容量制約や共有設定の問題が起きません。フォルダも **GASが自動で作成**します（スプレッドシートと同じ場所に「全店舗売上 バックアップ」フォルダ）。

> なぜGASか: 同期(6時)はこのスプレッドシート内のGoogle Apps Scriptが担当している。サービスアカウント（Supabase側）は自分のDriveに新規ファイル/フォルダを作れない仕様のため、Drive上のバックアップはGAS側で行うのが確実。

## ✅ 設定済み（確定構成・2026-06-16）
- スクリプト: 売上スプレッドシートに**紐づくコンテナバインド型**（プロジェクト名は「無題のプロジェクト」だが `getActiveSpreadsheet()` が通る＝`openById` 不要）。同期スクリプトと同じ `Code.gs` の末尾に `backupSalesSpreadsheet` / `getOrCreateBackupFolder_` を追加。
- 実行契機: **時間主導トリガー（日付ベース・午前7時〜8時 JST）** で `backupSalesSpreadsheet` を毎日実行。＝**毎朝6時の同期の後**に走る（同期で入った当日の数値をそのままコピー）。エラー通知=毎日通知を受け取る（失敗時はメール）。
- 初回手動実行で **「全店舗売上 バックアップ」フォルダ＋当日コピー** 作成済み・Drive権限承認済み。
- ※「7時台」ではなく**同期完了の直後**に厳密に走らせたい場合は、トリガーを使わず、6時同期の関数の最後の行に `backupSalesSpreadsheet();` を1行足す（下記の (A)）。現状はトリガー方式 (B) を採用。

---

## 貼り付けるコード

スプレッドシートを開く → **拡張機能 → Apps Script** → 下記を貼り付けて保存。

```javascript
// ===== 全店舗売上 バックアップ（毎日・同期後） =====
var BACKUP_FOLDER_NAME = '全店舗売上 バックアップ';
var KEEP_DAYS = 90; // この日数より古いコピーはゴミ箱へ（復元可能）。全部残すなら 0。

function backupSalesSpreadsheet() {
  // 同期スクリプトと同じスプレッドシートを対象にする（このスクリプトがスプレッドシートに紐づく場合）。
  // もし「スタンドアロン」スクリプトなら、次行を openById('スプレッドシートID') に置き換える。
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var file = DriveApp.getFileById(ss.getId());
  var folder = getOrCreateBackupFolder_(file);

  var tz = ss.getSpreadsheetTimeZone() || 'Asia/Tokyo';
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var name = ss.getName() + '_' + stamp;

  // 同じ日に複数回動いてもコピーは1つ（古い同日コピーはゴミ箱へ）。
  var dup = folder.getFilesByName(name);
  while (dup.hasNext()) dup.next().setTrashed(true);

  file.makeCopy(name, folder); // スプレッドシートを丸ごとコピー

  // 古いバックアップの掃除（任意）。
  if (KEEP_DAYS > 0) {
    var limit = new Date().getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    var olds = folder.getFiles();
    while (olds.hasNext()) {
      var f = olds.next();
      if (f.getDateCreated().getTime() < limit) f.setTrashed(true);
    }
  }
}

// スプレッドシートと同じ場所に専用フォルダを作る（無ければ作成）。
function getOrCreateBackupFolder_(file) {
  var parents = file.getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var it = parent.getFoldersByName(BACKUP_FOLDER_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(BACKUP_FOLDER_NAME);
}
```

---

## 「6時同期の直後」に動かす（どちらか1つ）

**(A) 同期の最後で呼ぶ ＝ おすすめ（確実に同期後）**
既存の「6時に同期する関数」の**最後の行**に、次の1行を足すだけ：
```javascript
  backupSalesSpreadsheet();
```
（同期が終わってからバックアップが走るので、タイミングが確実）

**(B) 別トリガーで動かす ＝ 同期スクリプトを触りたくない場合【今回採用】**
Apps Scriptの左メニュー **トリガー（時計アイコン）→ トリガーを追加**：
- 実行する関数 … `backupSalesSpreadsheet`
- デプロイ … Head ／ イベントのソース … 時間主導型 → 日付ベースのタイマー → **午前7時〜8時（JST/GMT+09:00）**
- ※6時の同期が終わった後（7時台）に走らせる。同期完了の**直後**に厳密に走らせたいなら (A) が上。

---

## 初回セットアップ（1回だけ）
1. エディタ上部の関数選択で `backupSalesSpreadsheet` を選び、**▶ 実行**。
2. **権限の承認ダイアログ**（Driveへのアクセス）が出るので承認する（GAS所有者＝スプレッドシート所有者のアカウントで）。
3. スプレッドシートと同じ場所に **「全店舗売上 バックアップ」フォルダ** ができ、中に `（スプレッドシート名）_2026-06-16` のコピーが入っていることを確認。

## 補足
- コピーは**スプレッドシート丸ごと**（全タブ・値）。日付名で毎日1ファイル。
- `KEEP_DAYS`（既定90）より古いコピーは自動でゴミ箱へ（ゴミ箱なので復元可能）。全部残すなら `KEEP_DAYS = 0`。
- スクリプトが**スタンドアロン**（スプレッドシートに紐づかない独立プロジェクト）の場合は、`SpreadsheetApp.getActiveSpreadsheet()` を `SpreadsheetApp.openById('対象スプレッドシートID')` に置き換える（IDはスプレッドシートURLの `/d/` と `/edit` の間）。
