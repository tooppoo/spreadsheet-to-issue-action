

## 認証セットアップについて

このActionは、Google Sheets APIへのアクセスにアクセストークンを利用します。呼び出し側のワークフローで `google-github-actions/auth@v2` を実行してアクセストークンを発行し、`GOOGLE_OAUTH_ACCESS_TOKEN`（または `ACCESS_TOKEN`）として本Actionに渡してください。

詳しいセットアップ手順や注意点は、[認証セットアップガイド](docs/setup-oidc.md) をご参照ください。

### クイックスタート（推奨）

1) リポジトリに必要なSecretsを用意
- `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`
- `GOOGLE_SERVICE_ACCOUNT`
- `SPREADSHEET_ID`

2) ワークフローでアクセストークンを発行し、本Actionへ渡す

```yaml
jobs:
  sync-spreadsheet:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
  id-token: write  # アクセストークン発行に必要
    steps:
      - uses: actions/checkout@v4

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
          body_template: "内容: {{ row.C }}\n期限: {{ row.D }}"
          sync_column: "E"
```

ヒント:
- 本Actionは `GOOGLE_OAUTH_ACCESS_TOKEN` を優先し、見つからない場合は `ACCESS_TOKEN` を自動検出します。
- スコープは Google Sheets への読み書きが必要なため、`https://www.googleapis.com/auth/spreadsheets` を指定してください。

---

## 概要

Googleスプレッドシートを読み取り、未連携行に対してGitHub Issueを作成します。作成成功時は指定列へ指定の値（既定: TRUE）を書き戻し、重複作成を防ぎます。Workload Identity Federation（WIF）によるGoogle認証で安全に実行します。

## 主要機能

- mustacheテンプレートで `{{ row.A }}` のように列参照してタイトル/本文を生成
- Google Sheets API に読み書きアクセス（アクセストークン利用）
- 成功時に `sync_column` のセルへ書き戻し値（既定: TRUE）を設定
- `max_issues_per_run` と `rate_limit_delay` でレート制御
- 途中失敗は継続し、集計値とURL一覧を出力

### テンプレートで利用可能な変数

- `row`: 列ごとの値を列記号で参照できます（例: `{{ row.A }}`, `{{ row.B }}`）。`read_range` の開始列に応じて `A`, `B`, `C` ... が割り当てられます。
- `rowIndex`: スプレッドシート上の絶対行番号（1始まり）。`read_range` のオフセットを考慮した値です。
- `now`: 実行時刻のISO 8601文字列（例: `2025-09-27T12:34:56.789Z`）。

## 入力（Action inputs）

| Name | Required | Default | Description |
| --- | :--: | --- | --- |
| `github_token` | Yes | — | GitHub Issues作成用トークン（例: `secrets.GITHUB_TOKEN`） |
| `spreadsheet_id` | Yes | — | SpreadsheetドキュメントID |
| `sheet_name` | Yes | — | タブ名 |
| `title_template` | Yes | — | Issueタイトルのmustacheテンプレート |
| `body_template` | Yes | — | Issue本文のmustacheテンプレート |
| `sync_column` | Yes | — | 連携済み判定/書き戻し列（例: `"E"`） |
| `labels` | No | `""` | 付与ラベル。JSON配列またはカンマ区切り文字列をサポート |
| `max_issues_per_run` | No | `10` | 1回に作成する最大件数。0以下やNaNは「無制限」として扱われます |
| `rate_limit_delay` | No | `1000` | 1件ごとの待機ミリ秒 |
| `read_range` | No | `A:Z` | 列文字で始まるA1範囲のみ対応（例: `A:Z`, `C5:F`）。行のみの範囲（`5:10` 等）は非対応 |
| `data_start_row` | No | `2` | データ開始行。1未満の値はエラー。未指定や非数値は2にフォールバック |
| `boolean_truthy_values` | No | `["TRUE","true","True","1","はい","済"]` | 既連携判定のtruthy集合（JSON配列） |
| `sync_write_back_value` | No | `"TRUE"` | シートへ書き戻す値を上書き可能（例: `"済"`） |
| `dry_run` | No | `false` | 作成/書戻しを行わずログのみ |

## 出力（Action outputs）

| Name | Description |
| --- | --- |
| `processed_count` | 処理行数 |
| `created_count` | 作成件数 |
| `skipped_count` | スキップ件数 |
| `failed_count` | 失敗件数 |
| `created_issue_urls` | 作成IssueのURL配列（JSON）。サマリー掲載は最大100件 |
| `summary_markdown` | 集計とURL一覧のサマリーMarkdown |

## ワークフロー例

```yaml
jobs:
  sync-spreadsheet:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      id-token: write  # アクセストークン発行に必要
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
          # sync_write_back_value: '済'   # 既定は "TRUE"（表示用に変更したい場合）
          # read_range: 'A:Z'
          # data_start_row: '2'
          # boolean_truthy_values: '["TRUE","true","True","1","はい","済"]'
          # dry_run: 'false'
```

備考:

- 上記のGoogle認証ステップは `token_format: access_token` を使用しています。本Actionは環境変数 `GOOGLE_OAUTH_ACCESS_TOKEN` を優先し、見つからない場合は `ACCESS_TOKEN` にフォールバックしてトークンを検出します。
- 並行実行を避けたい場合は呼び出し側で `concurrency` を設定してください。
- Issue作成には成功したものの、スプレッドシートへの書き戻しに失敗した場合は、重複作成を防ぐためAction全体が失敗（fail）します。これは他の行処理エラー（警告を出して継続）とは異なる動作です。

## 開発メモ

- ランタイム: Node.js 22 / pnpm
- 形式: Composite Action（依存インストールとビルドはランナー上で実行）
- distはリポジトリにコミットしません

## ライセンス

MIT
