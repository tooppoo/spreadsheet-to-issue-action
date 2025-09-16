# Spreadsheet to Issue Action Setup

This action provides reusable workflows to sync Google Spreadsheet responses to GitHub Issues automatically.

## Features

- 🔄 Scheduled sync every 30 minutes
- 🛡️ OIDC authentication with Google Cloud
- 📊 Configurable templates for issue titles and bodies
- 🏷️ Automatic labeling
- 🚦 Rate limiting (3 API calls per second)
- 📝 Spreadsheet-based sync tracking (writes "連携済み" to designated column)
- 🧪 Dry-run mode for testing

## Setup

### 1. Google Cloud Configuration

1. Create a Google Cloud project
2. Enable the Google Sheets API
3. Create a service account with read and write access to your spreadsheet
4. Configure Workload Identity Federation for GitHub Actions

### 2. Repository Configuration

1. Copy `.github/spreadsheet-sync-config.json.example` to `.github/spreadsheet-sync-config.json`
2. Update the configuration with your spreadsheet details:

```json
{
  "spreadsheet_id": "your-spreadsheet-id",
  "sheet_name": "Sheet1",
  "sync_status_column": "Z",
  "sync_status_value": "連携済み",
  "title_template": "[{{ row.A }}] {{ row.B }}",
  "body_template": "## Details\n\n**Request from:** {{ row.A }}\n**Subject:** {{ row.B }}\n**Description:** {{ row.C }}\n\n---\n\n_Auto-generated from spreadsheet row {{ row_number }}_",
  "labels": ["spreadsheet-sync", "auto-created"],
  "repository": "owner/repo-name"
}
```

**重要**: スプレッドシートには「連携状態」を示すカラム（この例では Z カラム）を用意する必要があります。このカラムに `sync_status_value` で指定した値（デフォルトは「連携済み」）が書き込まれることで、重複処理を防ぎます。

### 3. GitHub Secrets and Variables

Set up these repository variables:
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: Your Google service account email
- `WIF_PROVIDER`: The resource name of your Workload Identity Pool Provider, required for OIDC authentication with Google Cloud.
  Format: `projects/<project-number>/locations/global/workloadIdentityPools/<pool-id>/providers/<provider-id>`

The workflow uses the following repository secret:
- `GITHUB_TOKEN`: Automatically provided by GitHub Actions (no manual setup needed)

### 3.1 Required GITHUB_TOKEN permissions

This workflow creates GitHub issues and needs access to Google Cloud for spreadsheet operations. Grant the workflow the minimum required permissions:

```yaml
permissions:
  issues: write
  id-token: write
```

When calling this workflow from another repository, set these permissions in the calling job. For the included scheduled workflow in this repo, these permissions are already set.

### 4. Template Syntax

Use the following syntax in your templates:
- `{{ row.A }}`, `{{ row.B }}`, etc. for specific columns
- `{{ row_number }}` for the spreadsheet row number
- `{{ row | json }}` for the entire row as JSON

## Usage

### Scheduled Sync

The workflow runs automatically every 30 minutes via the scheduled trigger in `.github/workflows/scheduled-sync.yml`.

### Manual Sync

You can trigger a manual sync with optional dry-run mode:

1. Go to Actions tab in your repository
2. Select "Scheduled Spreadsheet Sync"
3. Click "Run workflow"
4. Optionally enable dry-run mode to test without creating issues

### Using in Other Repositories

You can use this as a reusable workflow in other repositories:

```yaml
name: Sync My Spreadsheet

on:
  schedule:
    - cron: '*/30 * * * *'

jobs:
  sync:
    permissions:
      issues: write
      id-token: write
    uses: your-org/spreadsheet-to-issue-action/.github/workflows/sync-spreadsheet-to-issues.yml@main
    with:
      config_path: '.github/my-config.json'
      sync_status_column: 'Z'
      google_service_account: ${{ vars.GOOGLE_SERVICE_ACCOUNT_EMAIL }}
      wif_provider: ${{ vars.WIF_PROVIDER }}
    secrets:
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Configuration Options

| Input | Description | Default | Required |
|-------|-------------|---------|----------|
| `config_path` | Path to configuration file | `.github/spreadsheet-sync-config.json` | No |
| `sync_status_column` | Column to mark sync status | `Z` | No |
| `google_service_account` | Google service account email | - | Yes |
| `wif_provider` | Workload Identity Federation provider | - | Yes |
| `max_issues_per_run` | Max issues to create per run | 50 | No |
| `rate_limit_delay` | Delay between API calls (seconds) | 0.33 | No |
| `dry_run` | Run without creating issues | false | No |

## Security Considerations

- Service account has read and write access to spreadsheets for sync status tracking
- Mentions (@) are automatically escaped to prevent notifications
- Rate limiting prevents API abuse
- OIDC authentication eliminates need for service account keys
