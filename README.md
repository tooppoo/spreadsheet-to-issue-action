## 概要

Googleスプレッドシートを読み取り、未連携行に対してGitHub Issueを作成します。作成成功時は指定列へTRUEを書き戻し、重複作成を防ぎます。OIDCを用いたGoogle認証（Workload Identity Federation）で安全に実行します。

## 主要機能

- mustacheテンプレートで `{{ row.A }}` のように列参照してタイトル/本文を生成
- OIDCでGoogle Sheets APIに読み書きアクセス
- 成功時に `sync_column` のセルへ TRUE を書き戻し
- `max_issues_per_run` と `rate_limit_delay` でレート制御
- 途中失敗は継続し、集計値とURL一覧を出力

## 入力（Action inputs）

- 必須
  - `github_token`: Issues作成用トークン（例: `secrets.GITHUB_TOKEN`）
  - `spreadsheet_id`: SpreadsheetドキュメントID
  - `sheet_name`: タブ名
  - `title_template`: mustacheテンプレート
  - `body_template`: mustacheテンプレート
  - `sync_column`: 連携済み判定/書き戻し列（例: `"E"`）
- 任意（既定値）
  - `labels`（既定: 空文字。JSON配列 or カンマ区切り）
  - `max_issues_per_run`（既定: 10。0以下やNaNは「無制限」として扱われます）
  - `rate_limit_delay`（既定: 1000ms）
  - `read_range`（既定: `A:Z`）
  - `data_start_row`（既定: 2）
  - `boolean_truthy_values`（既定: `["TRUE","true","True","1","はい","済"]`）
  - `dry_run`（既定: `false`）

## 出力（Action outputs）

- `processed_count`, `created_count`, `skipped_count`, `failed_count`
- `created_issue_urls`（JSON配列。サマリー掲載は最大100件）
- `summary_markdown`（集計とURL一覧）

## ワークフロー例

```yaml
jobs:
  sync-spreadsheet:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GOOGLE_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GOOGLE_SERVICE_ACCOUNT }}
          token_format: "access_token"
          access_token_scopes: "https://www.googleapis.com/auth/spreadsheets"

      - name: Sync spreadsheet to issues
        uses: tooppoo/spreadsheet-to-issue-action@0.0.1
        env:
          GOOGLE_OAUTH_ACCESS_TOKEN: ${{ steps.auth.outputs.access_token }}
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          spreadsheet_id: ${{ secrets.SPREADSHEET_ID }}
          sheet_name: "Sheet1"
          title_template: "[{{ row.A }}] {{ row.B }}"
          body_template: |
            内容: {{ row.C }}
            期限: {{ row.D }}
          labels: "spreadsheet-sync,auto-created"
          max_issues_per_run: 10
          rate_limit_delay: 1000
          sync_column: "E"
          # 任意:
          # read_range: 'A:Z'
          # data_start_row: '2'
          # boolean_truthy_values: '["TRUE","true","True","1","はい","済"]'
          # dry_run: 'false'
```

備考:

- 上記のGoogle認証ステップは `token_format: access_token` を使用しています。本Actionは環境変数 `GOOGLE_OAUTH_ACCESS_TOKEN`（または `ACCESS_TOKEN`）からトークンを自動検出します。
- 並行実行を避けたい場合は呼び出し側で `concurrency` を設定してください。

## 開発メモ

- ランタイム: Node.js 22 / pnpm
- 形式: Composite Action（依存インストールとビルドはランナー上で実行）
- distはリポジトリにコミットしません

## ライセンス

MIT
