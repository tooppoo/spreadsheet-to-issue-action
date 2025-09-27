import * as core from "@actions/core";
import * as github from "@actions/github";
import Mustache from "mustache";
import { OAuth2Client } from "google-auth-library";
import { sheets_v4, sheets as sheetsApi } from "@googleapis/sheets";

type RowMap = Record<string, string>;

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function parseLabels(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    const arr = JSON.parse(trimmed);
    if (Array.isArray(arr)) return arr.map((s) => String(s));
  } catch (_) {
    // fallthrough to CSV
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function colLetterToIndex(letter: string): number {
  // 'A' -> 0, 'B' -> 1 ... 'Z' -> 25, 'AA' -> 26
  let result = 0;
  for (const ch of letter.toUpperCase()) {
    const v = ch.charCodeAt(0) - 64; // A=1
    if (v < 1 || v > 26) throw new Error(`Invalid column letter: ${letter}`);
    result = result * 26 + v;
  }
  return result - 1;
}

function safeGet<T>(env: NodeJS.ProcessEnv, key: string, def?: T): string | T {
  const v = env[key];
  if (v === undefined || v === "") return (def as any) ?? "";
  return v;
}

async function main() {
  core.info("spreadsheet-to-issue-action: start");

  const env = process.env;
  const accessToken = env.GOOGLE_OAUTH_ACCESS_TOKEN || env.ACCESS_TOKEN || "";
  if (!accessToken) {
    throw new Error(
      "GOOGLE_OAUTH_ACCESS_TOKEN is not found. Ensure you run google-github-actions/auth@v2 with token_format: 'access_token' and export it as an environment variable.",
    );
  }

  const spreadsheetId = safeGet(env, "SPREADSHEET_ID") as string;
  const sheetName = safeGet(env, "SHEET_NAME") as string;
  const readRange = safeGet(env, "READ_RANGE", "A:Z");
  const dataStartRow = parseInt(safeGet(env, "DATA_START_ROW", "2"), 10) || 2;
  const truthyJson = safeGet(
    env,
    "BOOLEAN_TRUTHY_VALUES",
    '["TRUE","true","True","1","はい","済"]',
  ) as string;
  let truthyValues: string[] = [];
  try {
    truthyValues = JSON.parse(truthyJson);
    if (!Array.isArray(truthyValues)) throw new Error("not array");
    truthyValues = truthyValues.map((s) => String(s));
  } catch (e) {
    throw new Error(
      `boolean_truthy_values must be a JSON array: ${truthyJson}`,
    );
  }

  const titleTemplate = safeGet(env, "TITLE_TEMPLATE") as string;
  const bodyTemplate = safeGet(env, "BODY_TEMPLATE") as string;
  const syncColumnLetter = safeGet(env, "SYNC_COLUMN") as string;
  const labelsInput = safeGet(env, "LABELS", "") as string;
  const labels = parseLabels(labelsInput);
  const maxIssuesPerRun = parseInt(
    safeGet(env, "MAX_ISSUES_PER_RUN", "10"),
    10,
  );
  const rateLimitDelay = parseInt(safeGet(env, "RATE_LIMIT_DELAY", "1000"), 10);
  const dryRun =
    (safeGet(env, "DRY_RUN", "false") as string).toLowerCase() === "true";
  const githubToken = safeGet(env, "GITHUB_TOKEN") as string;

  if (!spreadsheetId || !sheetName) {
    throw new Error("SPREADSHEET_ID and SHEET_NAME are required");
  }
  if (!titleTemplate || !bodyTemplate) {
    throw new Error("TITLE_TEMPLATE and BODY_TEMPLATE are required");
  }
  if (!syncColumnLetter) {
    throw new Error("SYNC_COLUMN is required");
  }

  const syncColIndex = colLetterToIndex(syncColumnLetter);

  // Google Sheets client
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: accessToken });
  const sheets: sheets_v4.Sheets = sheetsApi({ version: "v4", auth });

  // Fetch values
  const range = `${sheetName}!${readRange}`;
  const getRes = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values: any[][] = getRes.data.values || [];

  if (values.length < dataStartRow - 1) {
    core.info("No data rows to process");
  }

  // Build header mapping: columns A,B,C...
  // We don't rely on header names; we expose row.A, row.B ... regardless of header content
  const now = new Date().toISOString();

  let processed = 0;
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const createdUrls: string[] = [];

  const octokit = github.getOctokit(githubToken);
  const { owner, repo } = github.context.repo;

  const startRowIndex = dataStartRow - 1; // zero-based in values array
  const limit = Number.isFinite(maxIssuesPerRun)
    ? maxIssuesPerRun
    : Number.MAX_SAFE_INTEGER;

  for (let i = startRowIndex; i < values.length; i++) {
    if (created >= limit) {
      core.info(`Reached max_issues_per_run (${limit}); stopping early`);
      break;
    }

    const rowValues = values[i] || [];

    // Determine synced
    const cellVal = String(rowValues[syncColIndex] ?? "").trim();
    const isSynced = truthyValues.includes(cellVal);
    if (isSynced) {
      skipped++;
      continue;
    }

    // Build row map A,B,C...
    const rowMap: RowMap = {};
    for (let c = 0; c < rowValues.length; c++) {
      const letter = columnNumberToLetters(c);
      rowMap[letter] = String(rowValues[c] ?? "");
    }

    const context = {
      row: rowMap,
      rowIndex: i + 1, // 1-based
      now,
    } as const;

    const title = Mustache.render(titleTemplate, context);
    const body = Mustache.render(bodyTemplate, context);

    try {
      processed++;
      let issueUrl: string | undefined;

      if (!dryRun) {
        const createRes = await octokit.rest.issues.create({
          owner,
          repo,
          title,
          body,
          labels,
        });
        issueUrl = createRes.data.html_url;
        if (createdUrls.length < 100 && issueUrl) createdUrls.push(issueUrl);

        // Write back TRUE to sync column for this row
        const rowNumber = i + 1; // sheet is 1-based
        const targetRange = `${sheetName}!${syncColumnLetter}${rowNumber}`;
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: targetRange,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[true]] },
        });
        created++;
      } else {
        core.info(`[dry_run] Create issue: ${title}`);
        created++;
      }
    } catch (err: any) {
      failed++;
      core.warning(
        `Error processing row ${i + 1}: ${err?.message || String(err)}`,
      );
    }

    if (rateLimitDelay > 0) {
      await sleep(rateLimitDelay);
    }
  }

  const summary = [
    `Processed: ${processed}`,
    `Created: ${created}`,
    `Skipped: ${skipped}`,
    `Failed: ${failed}`,
    "",
    ...createdUrls.map((u) => `- ${u}`),
  ].join("\n");

  core.setOutput("processed_count", String(processed));
  core.setOutput("created_count", String(created));
  core.setOutput("skipped_count", String(skipped));
  core.setOutput("failed_count", String(failed));
  core.setOutput("created_issue_urls", JSON.stringify(createdUrls));
  core.setOutput("summary_markdown", summary);

  core.info("spreadsheet-to-issue-action: done");
}

function columnNumberToLetters(index: number): string {
  // 0 -> A
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

main().catch((err) => {
  core.setFailed(err?.message || String(err));
});
