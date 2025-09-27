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

function safeGet(env: NodeJS.ProcessEnv, key: string): string;
function safeGet<T>(env: NodeJS.ProcessEnv, key: string, def: T): T | string;
function safeGet<T>(env: NodeJS.ProcessEnv, key: string, def?: T): string | T {
  const v = env[key];
  if (v === undefined || v === "") {
    return def === undefined ? "" : def;
  }
  return v;
}

// Parse the start reference of an A1 range (e.g. 'C5:F' -> { startColIndex: 2, startRowNumber: 5 })
function parseA1Start(a1: string): {
  startColIndex: number;
  startRowNumber: number;
} {
  const trimmed = a1.trim();
  const firstRef = trimmed.split(":")[0]; // e.g. 'C5'
  const refParts = firstRef.split("!");
  const ref = refParts[refParts.length - 1];
  // Match optional $ then letters, optional $ then digits
  const m = ref.match(/\$?([A-Za-z]+)\$?(\d+)?/);
  if (!m) {
    throw new Error(
      `READ_RANGE must start with a column reference (e.g., 'A:Z', 'C5:F'). Given: '${a1}'`,
    );
  }
  const letters = m[1];
  const digits = m[2] ? parseInt(m[2], 10) : 1;
  return { startColIndex: colLetterToIndex(letters), startRowNumber: digits };
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

  const spreadsheetId = safeGet(env, "SPREADSHEET_ID");
  const sheetName = safeGet(env, "SHEET_NAME");
  const readRange = safeGet(env, "READ_RANGE", "A:Z");
  const dataStartRowInput = safeGet(env, "DATA_START_ROW", "2");
  let dataStartRow = parseInt(dataStartRowInput, 10);
  if (Number.isNaN(dataStartRow)) {
    dataStartRow = 2;
  }
  if (dataStartRow < 1) {
    throw new Error(
      `data_start_row must be a positive integer, but got ${dataStartRow}.`,
    );
  }
  const truthyJson = safeGet(
    env,
    "BOOLEAN_TRUTHY_VALUES",
    '["TRUE","true","True","1","はい","済"]',
  );
  let truthyValues: string[];
  try {
    const parsed = JSON.parse(truthyJson);
    if (!Array.isArray(parsed)) {
      throw new Error("Input is not a JSON array.");
    }
    truthyValues = parsed.map((s) => String(s));
  } catch (e) {
    throw new Error(
      `'boolean_truthy_values' must be a valid JSON array. Input: ${truthyJson}. Error: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const titleTemplate = safeGet(env, "TITLE_TEMPLATE");
  const bodyTemplate = safeGet(env, "BODY_TEMPLATE");
  const syncColumnLetter = safeGet(env, "SYNC_COLUMN");
  const labelsInput = safeGet(env, "LABELS", "");
  const labels = parseLabels(labelsInput);
  const maxIssuesPerRun = parseInt(
    safeGet(env, "MAX_ISSUES_PER_RUN", "10"),
    10,
  );
  const rateLimitDelay = parseInt(safeGet(env, "RATE_LIMIT_DELAY", "1000"), 10);
  const dryRun = safeGet(env, "DRY_RUN", "false").toLowerCase() === "true";
  const githubToken = safeGet(env, "GITHUB_TOKEN");
  const syncWriteBackValue = safeGet(env, "SYNC_WRITE_BACK_VALUE", "TRUE");

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
  const values: unknown[][] = getRes.data.values || [];

  // Determine offsets derived from readRange (start column/row in the sheet)
  const { startColIndex, startRowNumber } = parseA1Start(readRange);

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

  // Translate sheet-level dataStartRow to values[] index by subtracting the range's base row
  const startRowIndex = Math.max(0, dataStartRow - startRowNumber);
  // Treat non-positive or NaN values as "no limit"
  const limit = maxIssuesPerRun > 0 ? maxIssuesPerRun : Number.MAX_SAFE_INTEGER;

  let warnedSyncOutOfRange = false;
  for (let i = startRowIndex; i < values.length; i++) {
    if (created >= limit) {
      core.info(`Reached max_issues_per_run (${limit}); stopping early`);
      break;
    }

    const rowValues = values[i] || [];

    // Determine synced
    const syncIndexInRow = syncColIndex - startColIndex;
    let cellVal = "";
    if (syncIndexInRow >= 0 && syncIndexInRow < rowValues.length) {
      cellVal = String(rowValues[syncIndexInRow] ?? "").trim();
    } else if (!warnedSyncOutOfRange) {
      core.warning(
        `SYNC_COLUMN (${syncColumnLetter}) is outside READ_RANGE (${readRange}). Existing sync flags cannot be read; rows will be treated as unsynced.`,
      );
      warnedSyncOutOfRange = true;
    }
    const isSynced = truthyValues.includes(cellVal);
    if (isSynced) {
      skipped++;
      continue;
    }

    // Build row map A,B,C...
    const rowMap: RowMap = {};
    for (let c = 0; c < rowValues.length; c++) {
      const letter = columnNumberToLetters(startColIndex + c);
      rowMap[letter] = String(rowValues[c] ?? "");
    }

    // Absolute row number in the sheet (1-based)
    const rowNumber = startRowNumber + i;

    const context = {
      row: rowMap,
      // Row index in the sheet (1-based), accounting for readRange offset
      rowIndex: rowNumber,
      now,
    } as const;

    const title = Mustache.render(titleTemplate, context);
    const body = Mustache.render(bodyTemplate, context);

    // Skip if the rendered title is empty to avoid creating blank issues
    if (title.trim().length === 0) {
      skipped++;
      core.info(`Skipping row ${rowNumber}: empty title after rendering`);
      continue;
    }

    try {
      processed++;

      if (!dryRun) {
        const createRes = await octokit.rest.issues.create({
          owner,
          repo,
          title,
          body,
          labels,
        });
        const issueUrl = createRes.data.html_url;
        if (createdUrls.length < 100) createdUrls.push(issueUrl);

        // Write back TRUE to sync column for this row
        // Sheet is 1-based; adjust for readRange offset
        const targetRange = `${sheetName}!${syncColumnLetter}${rowNumber}`;
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: targetRange,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[syncWriteBackValue]] },
        });
        created++;
      } else {
        core.info(`[dry_run] Create issue: ${title}`);
        created++;
      }
    } catch (err: unknown) {
      failed++;
      core.warning(
        `Error processing row ${rowNumber}: ${err instanceof Error ? err.message : String(err)}`,
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

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
