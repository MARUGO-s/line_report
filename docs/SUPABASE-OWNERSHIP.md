# Supabase共有プロジェクト所有範囲

LINE Report はSupabaseプロジェクト `hocbnifuactbvmyjraxy` を使用します。
同じプロジェクトにはレシピ管理など別アプリのEdge Functionsも存在するため、
「同一プロジェクトにあるものすべて」を本リポジトリの管理対象とは扱いません。

## 正本

機械可読の所有台帳は `knowledge/supabase-ownership.json` です。

- `ownedFunctions`: このリポジトリからデプロイするEdge Functions
- `journalReportTables`: Journal Report固有の主要テーブル
- `journalReportStorageBuckets`: Journal Report固有の非公開Storage
- `sharedRiskBoundary`: 他アプリと共有する障害・コスト境界

## 運用ルール

1. Edge Functionsのデプロイ対象は `ownedFunctions` と一致させる。
2. 本番に別アプリのFunctionが存在しても、このリポジトリから削除・上書きしない。
3. `supabase/functions/` に新しいFunctionを追加した場合は、台帳にも明示的に追加する。
4. 台帳に存在するFunctionのディレクトリが消えた場合はCIを失敗させる。
5. Journal ReportのDB・Storageは公開Pagesから直接触らず、`admin-api` 経由を維持する。
6. `chat-push` はチャット専用Web Push購読をservice_roleで管理し、ブラウザのSupabase Auth access tokenを関数内で検証する。

## 共有される影響範囲

テーブル名が分かれていても、次はプロジェクト単位で共有されます。

- Edge Functionクォータと名前空間
- DB接続数・CPU・I/O
- Storage容量
- 課金
- Edge Secretsとservice role
- プロジェクト障害・設定変更

別アプリのデプロイや負荷がLINE Reportへ影響し得ることを前提に監視します。
