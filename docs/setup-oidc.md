# OIDC認証セットアップ手順（Google Sheets）

このActionは、`google-github-actions/auth@v2` を用いたOIDC認証（Workload Identity Federation）でGoogle Sheets APIにアクセスします。

## 前提

- GCPプロジェクトがあること
- GitHubリポジトリ/Orgの管理権限があること

## 手順

1. Google Sheets API を有効化
   - Cloud Console > APIs & Services > Library > Google Sheets API > Enable

2. サービスアカウント作成
   - IAM & Admin > Service Accounts > Create
   - 名前は任意。ロールは不要（後で権限はスプレッドシート側の共有で付与）

3. Workload Identity Federation（WIF）を設定
   - IAM & Admin > Workload Identity Federation > Pool作成
   - ProviderはGitHubを選択 or OIDC Providerを作成し、対象のリポジトリ/Orgに制限
   - SAへの関連付け（PrincipalをProviderにバインド）を行い、GitHubからのOIDCでそのSAを偽装できるようにする

4. 対象スプレッドシートをサービスアカウントに共有
   - スプレッドシートを開き、共有でサービスアカウントのメールを「編集者」として追加

5. GitHub側の設定
   - リポジトリのSecretsに以下を追加
     - `GOOGLE_WORKLOAD_IDENTITY_PROVIDER`: 例 `projects/…/locations/global/workloadIdentityPools/…/providers/…`
     - `GOOGLE_SERVICE_ACCOUNT`: サービスアカウントのメール
     - `SPREADSHEET_ID`: 対象スプレッドシートのID
   - ワークフローファイルで `google-github-actions/auth@v2` を呼ぶ際、次を指定
     - `token_format: 'access_token'`
     - `access_token_scopes: 'https://www.googleapis.com/auth/spreadsheets'`

参考: https://github.com/google-github-actions/auth
