# OIDC認証セットアップ手順

1. GCPでSheets API有効化
2. サービスアカウント作成
3. Workload Identity Federation（WIF）設定
4. Spreadsheetをサービスアカウントに編集者共有
5. GitHubリポジトリSecretsに以下を登録
   - GOOGLE_WORKLOAD_IDENTITY_PROVIDER
   - GOOGLE_SERVICE_ACCOUNT
   - SPREADSHEET_ID
   - GITHUB_TOKEN
