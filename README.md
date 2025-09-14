# spreadsheet-to-issue-action
googleスプレッドシートのレコードを元にGitHub Issueを立てるアクション

**他リポジトリから再利用可能ワークフローを呼び出す手順**

- このリポジトリには、`workflow_call` で呼び出せる再利用可能ワークフローがあります。
  - ファイル: `.github/workflows/sync-spreadsheet-to-issues.yml`

## 1. 呼び出し側リポジトリにワークフローを作成

呼び出し側リポジトリに、以下のようなワークフローを追加します。`<OWNER>/<REPO>` と参照バージョンは自分の環境に合わせて置き換えてください（タグやコミットSHAで固定することを推奨）。

```yaml
name: Scheduled Spreadsheet Sync

on:
  schedule:
    - cron: '*/30 * * * *'
  workflow_dispatch:

jobs:
  sync:
    permissions:
      contents: write
      issues: write
      id-token: write
    uses: <OWNER>/<REPO>/.github/workflows/sync-spreadsheet-to-issues.yml@vX.Y.Z
    with:
      config_path: '.github/spreadsheet-sync-config.json'
      sync_state_path: '.github/sync-state.json'
      google_service_account: ${{ vars.GOOGLE_SERVICE_ACCOUNT_EMAIL }}
      wif_provider: ${{ vars.WIF_PROVIDER }}
      max_issues_per_run: 50
      rate_limit_delay: 0.33
      dry_run: false
    secrets:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

ポイント:
- `permissions` に `contents: write`, `issues: write`, `id-token: write` が必須です（状態ファイルのコミット・Issue作成・OIDC用）。
- `GITHUB_TOKEN` を呼び出し側から明示的に渡してください。

## 2. 設定ファイルを追加

呼び出し側リポジトリに `.github/spreadsheet-sync-config.json` を作成し、以下を参考に値を設定します（このリポジトリの `.github/spreadsheet-sync-config.json.example` をコピー可）。

```json
{
  "spreadsheet_id": "<Google スプレッドシートID>",
  "sheet_name": "Sheet1",
  "title_template": "[{{ row.A }}] {{ row.B }}",
  "body_template": "... {{ row.C }} ... _{{ row_number }}_",
  "labels": ["spreadsheet-sync", "auto-created"],
  "repository": "<issues を作成する GitHub リポジトリ>"
}
```

- `spreadsheet_id`: 対象スプレッドシートのID。
- `sheet_name`: 読み取りシート名（省略時 `Sheet1`）。
- `title_template` / `body_template`: `{{ row.A }}` のように列参照、`{{ row_number }}`, `{{ row | json }}` が使用可能。ワークフロー内で `@` は全角 `＠` に置換されます（不要メンション防止）。
- `labels`: 付与するIssueラベル配列。
- `repository`: 既定は実行中のリポジトリ。別リポジトリにIssueを作成したい場合に指定します。
  - **注意:** 別リポジトリにIssueを作成する場合、呼び出し側ワークフローで渡すトークンには、そのリポジトリへの`issues: write`権限が必要です。既定の`GITHUB_TOKEN`は実行中のリポジトリにしか権限がないため、代わりにPersonal Access Token (PAT)などを`secrets`に設定して渡す必要があります。

## 3. Google 認証（Workload Identity Federation）

ワークフローは `google-github-actions/auth` を用いてOIDCでGoogleに認証します。以下を準備してください。

- Google Cloudでサービスアカウントを作成し、Google Sheets API を有効化。
- 対象スプレッドシートをサービスアカウントのメールアドレスに共有（閲覧権限以上）。
- Workload Identity Federation のプロバイダを作成し、GitHubリポジトリ/Orgと関連付け。（設定方法の詳細は [google-github-actions/auth のドキュメント](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation) を参照）
- 呼び出し側リポジトリの Actions 変数（`Settings > Secrets and variables > Actions > Variables`）に以下を登録、または `with:` で直接値を渡す。
  - `GOOGLE_SERVICE_ACCOUNT_EMAIL`: サービスアカウントのメール
  - `WIF_PROVIDER`: プロバイダリソース名（例: `projects/…/locations/global/workloadIdentityPools/…/providers/…`）

## 4. どう動くか（概要）

- 前回処理行（`.github/sync-state.json`）より後の新規行を取得し、テンプレートでIssueを作成します。
- 実行後は最後に処理した行番号を `.github/sync-state.json` に書き戻し、同ブランチへコミット＆プッシュします。
- `max_issues_per_run` と `rate_limit_delay` で作成件数とレートを制御できます。`dry_run: true` で作成せずログのみ出力します。

## 5. 入力パラメータ

| 入力パラメータ | 型 | 説明 | 既定値 | 必須 |
|---|---|---|---|---|
| `config_path` | string | 設定ファイルへのパス | `.github/spreadsheet-sync-config.json` | No |
| `sync_state_path` | string | 同期状態ファイルへのパス | `.github/sync-state.json` | No |
| `google_service_account` | string | Googleサービスアカウントのメールアドレス | - | Yes |
| `wif_provider` | string | Workload Identity Federationプロバイダのリソース名 | - | Yes |
| `max_issues_per_run` | number | 1回の実行で作成するIssueの最大数 | `50` | No |
| `rate_limit_delay` | number | API呼び出し間の遅延（秒） | `0.33` | No |
| `dry_run` | boolean | Issueを作成せずにログのみ出力する | `false` | No |
| `secrets.GITHUB_TOKEN` | secret | GitHub API認証用のトークン | - | Yes |

## 6. バージョン固定の推奨

呼び出しはタグ（例: `@v1`）やコミットSHAで固定してください。例:

```
uses: <OWNER>/<REPO>/.github/workflows/sync-spreadsheet-to-issues.yml@v1
```

以上で、他リポジトリからこのワークフローを安全に再利用できます。
