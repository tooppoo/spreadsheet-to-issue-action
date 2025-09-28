# OIDC認証セットアップ手順（Google Sheets）

このActionは、`google-github-actions/auth@v2` を用いたOIDC（Workload Identity Federation）でGoogle Sheets APIにアクセスします。呼び出し側のワークフローでアクセストークンを発行し、`GOOGLE_OAUTH_ACCESS_TOKEN`（または `ACCESS_TOKEN`）として本Actionに渡してください。

## 前提

- GCPプロジェクトがあること
- GitHubリポジトリ/Orgの管理権限があること

## 手順（外部OIDCでアクセストークンを発行）

1) Google Sheets API を有効化
- Cloud Console > APIs & Services > Library > Google Sheets API > Enable

2) サービスアカウント作成
- IAM & Admin > Service Accounts > Create
- 名前は任意。ロールは不要（後で権限はスプレッドシート側の共有で付与）

3) Workload Identity Federation（WIF）を設定
- IAM & Admin > Workload Identity Federation > Pool作成
- ProviderはGitHubを選択 or OIDC Providerを作成し、対象のリポジトリ/Orgに制限
- サービスアカウント（SA）に対して、作成したProviderからの偽装（impersonation）ができるよう関連付け

4) 対象スプレッドシートをサービスアカウントに共有
- スプレッドシートを開き、共有でサービスアカウントのメールを「編集者」として追加

5) GitHub側の設定
- リポジトリのSecretsに以下を追加
  - `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`: 例 `projects/.../locations/global/workloadIdentityPools/.../providers/...`
  - `GOOGLE_SERVICE_ACCOUNT`: サービスアカウントのメール
  - `SPREADSHEET_ID`: 対象スプレッドシートのID

6) ワークフローの設定
- ワークフローに以下のpermissionsを付与
  - `permissions: { contents: read, issues: write, id-token: write }`
- OIDCでアクセストークンを発行し、本Actionへ渡す

例:

```yaml
jobs:
  sync-spreadsheet:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v4

      - name: Authenticate to Google Cloud
        id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GOOGLE_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GOOGLE_SERVICE_ACCOUNT }}
          token_format: 'access_token'
          access_token_scopes: 'https://www.googleapis.com/auth/spreadsheets'

      - name: Sync spreadsheet to issues
        uses: tooppoo/spreadsheet-to-issue-action@vX.Y.Z
        env:
          GOOGLE_OAUTH_ACCESS_TOKEN: ${{ steps.auth.outputs.access_token }}
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          spreadsheet_id: ${{ secrets.SPREADSHEET_ID }}
          sheet_name: 'Sheet1'
          title_template: '[{{ row.A }}] {{ row.B }}'
          body_template: |
            内容: {{ row.C }}
            期限: {{ row.D }}
          sync_column: 'E'
```

注意:
- `token_format` は `access_token` を指定してください。
- スコープは `https://www.googleapis.com/auth/spreadsheets` を使用します。
- 本Actionは `GOOGLE_OAUTH_ACCESS_TOKEN` を優先し、見つからない場合は `ACCESS_TOKEN` を使用します。

参考: https://github.com/google-github-actions/auth
