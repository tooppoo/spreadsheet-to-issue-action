import * as core from "@actions/core";
import * as github from "@actions/github";
import Mustache from "mustache";
import { OAuth2Client } from "google-auth-library";
import { sheets_v4, sheets as sheetsApi } from "@googleapis/sheets";

type RowMap = Record<string, string>;

// Mustache テンプレートに渡すコンテキスト型
type TemplateContext = {
  readonly row: RowMap;
  readonly rowIndex: number;
  readonly now: string;
};

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

type LabelInput = string | { name: string; [k: string]: unknown };

function isLabelObject(v: unknown): v is { name: string } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { name?: unknown }).name === "string"
  );
}

function parseLabels(input: string | undefined): LabelInput[] | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  // Try JSON parse only when the input looks like a JSON array
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        // Preserve label objects if provided; normalize strings
        return arr.map((v): LabelInput => {
          if (typeof v === "string") return v;
          if (isLabelObject(v)) return { name: v.name };
          return String(v);
        });
      }
    } catch (e) {
      core.warning(
        `Could not parse labels input as JSON array, falling back to CSV. Error: ${e instanceof Error ? e.message : String(e)}`,
      );
      // fallthrough to CSV
    }
  }
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeLabels(
  labels: LabelInput[] | undefined,
): string[] | undefined {
  return labels?.map((l) => (typeof l === "string" ? l : l.name));
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
  // Match the entire ref: optional $ then letters, optional $ then digits
  const m = ref.match(/^\$?([A-Za-z]+)\$?(\d+)?$/);
  if (!m) {
    throw new Error(
      `READ_RANGE must start with a column reference (e.g., 'A:Z', 'C5:F'). Given: '${a1}'`,
    );
  }
  const letters = m[1];
  const digits = m[2] ? parseInt(m[2], 10) : 1;
  return { startColIndex: colLetterToIndex(letters), startRowNumber: digits };
}

type Config = {
  accessToken: string;
  spreadsheetId: string;
  sheetName: string;
  readRange: string;
  dataStartRow: number;
  truthyValues: string[];
  titleTemplate: string;
  bodyTemplate: string;
  syncColumnLetter: string;
  labels: LabelInput[] | undefined;
  maxIssuesPerRun: number;
  rateLimitDelay: number;
  dryRun: boolean;
  githubToken: string;
  syncWriteBackValue: string;
};

function parseConfig(env: NodeJS.ProcessEnv): Config {
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
  if (Number.isNaN(dataStartRow)) dataStartRow = 2;
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
    if (!Array.isArray(parsed)) throw new Error("Input is not a JSON array.");
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
  const maxIssuesPerRunInput = safeGet(env, "MAX_ISSUES_PER_RUN", "10");
  let maxIssuesPerRun = parseInt(maxIssuesPerRunInput, 10);
  if (Number.isNaN(maxIssuesPerRun)) {
    core.warning(
      `Invalid 'max_issues_per_run' input: '${maxIssuesPerRunInput}'. Treating as unlimited.`,
    );
    maxIssuesPerRun = 0;
  }
  const rateLimitDelayInput = safeGet(env, "RATE_LIMIT_DELAY", "1000");
  let rateLimitDelay = parseInt(rateLimitDelayInput, 10);
  if (Number.isNaN(rateLimitDelay)) {
    core.warning(
      `Invalid 'rate_limit_delay' input: '${rateLimitDelayInput}'. Using default 1000ms.`,
    );
    rateLimitDelay = 1000;
  }
  const dryRun = safeGet(env, "DRY_RUN", "false").toLowerCase() === "true";
  const githubToken = safeGet(env, "GITHUB_TOKEN");
  const syncWriteBackValue = safeGet(env, "SYNC_WRITE_BACK_VALUE", "TRUE");

  if (!githubToken) throw new Error("GITHUB_TOKEN is required");
  if (!spreadsheetId || !sheetName)
    throw new Error("SPREADSHEET_ID and SHEET_NAME are required");
  if (!titleTemplate || !bodyTemplate)
    throw new Error("TITLE_TEMPLATE and BODY_TEMPLATE are required");
  if (!syncColumnLetter) throw new Error("SYNC_COLUMN is required");

  return {
    accessToken,
    spreadsheetId,
    sheetName,
    readRange,
    dataStartRow,
    truthyValues,
    titleTemplate,
    bodyTemplate,
    syncColumnLetter,
    labels,
    maxIssuesPerRun,
    rateLimitDelay,
    dryRun,
    githubToken,
    syncWriteBackValue,
  };
}

type ProcessResult = {
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  createdUrls: string[];
};

async function processRows(
  cfg: Config,
  values: unknown[][],
  startColIndex: number,
  startRowNumber: number,
  sheets: sheets_v4.Sheets,
  octokit: ReturnType<typeof github.getOctokit>,
): Promise<ProcessResult> {
  const now = new Date().toISOString();
  let processed = 0;
  let created = 0;
  let skipped = 0;
  let failed = 0;
  const createdUrls: string[] = [];
  const { owner, repo } = github.context.repo;
  const syncColIndex = colLetterToIndex(cfg.syncColumnLetter);
  const startRowIndex = Math.max(0, cfg.dataStartRow - startRowNumber);
  const limit =
    cfg.maxIssuesPerRun > 0 ? cfg.maxIssuesPerRun : Number.MAX_SAFE_INTEGER;

  let warnedSyncOutOfRange = false;
  for (let i = startRowIndex; i < values.length; i++) {
    if (created >= limit) {
      core.info(`Reached max_issues_per_run (${limit}); stopping early`);
      break;
    }

    const rowValues = values[i] || [];

    const syncIndexInRow = syncColIndex - startColIndex;
    let cellVal = "";
    if (syncIndexInRow >= 0 && syncIndexInRow < rowValues.length) {
      cellVal = String(rowValues[syncIndexInRow] ?? "").trim();
    } else if (!warnedSyncOutOfRange) {
      core.warning(
        `SYNC_COLUMN (${cfg.syncColumnLetter}) is outside READ_RANGE (${cfg.readRange}). Existing sync flags cannot be read; rows will be treated as unsynced.`,
      );
      warnedSyncOutOfRange = true;
    }
    const isSynced = cfg.truthyValues.includes(cellVal);
    if (isSynced) {
      skipped++;
      continue;
    }

    const rowNumber = startRowNumber + i;
    const result = await processSingleRow({
      cfg,
      now,
      owner,
      repo,
      sheets,
      octokit,
      rowValues,
      startColIndex,
      rowNumber,
    });
    processed += result.processed;
    created += result.created;
    skipped += result.skipped;
    failed += result.failed;
    if (result.issueUrl && createdUrls.length < 100)
      createdUrls.push(result.issueUrl);

    if (cfg.rateLimitDelay > 0) await sleep(cfg.rateLimitDelay);
  }

  return { processed, created, skipped, failed, createdUrls };
}

// 1行分の処理を担当
async function processSingleRow(args: {
  cfg: Config;
  now: string;
  owner: string;
  repo: string;
  sheets: sheets_v4.Sheets;
  octokit: ReturnType<typeof github.getOctokit>;
  rowValues: unknown[];
  startColIndex: number;
  rowNumber: number;
}): Promise<{
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  issueUrl?: string;
}> {
  const {
    cfg,
    now,
    owner,
    repo,
    sheets,
    octokit,
    rowValues,
    startColIndex,
    rowNumber,
  } = args;

  // 行マップを生成
  const rowMap: RowMap = {};
  for (let c = 0; c < rowValues.length; c++) {
    const letter = columnNumberToLetters(startColIndex + c);
    rowMap[letter] = String(rowValues[c] ?? "");
  }

  // テンプレートレンダリング
  const context: TemplateContext = { row: rowMap, rowIndex: rowNumber, now };
  const title = Mustache.render(cfg.titleTemplate, context);
  const body = Mustache.render(cfg.bodyTemplate, context);
  if (title.trim().length === 0) {
    core.info(`Skipping row ${rowNumber}: empty title after rendering`);
    return { processed: 0, created: 0, skipped: 1, failed: 0 };
  }

  try {
    if (!cfg.dryRun) {
      const createRes = await octokit.rest.issues.create({
        owner,
        repo,
        title,
        body,
        labels: normalizeLabels(cfg.labels),
      });
      const issueUrl = createRes.data.html_url;
      const targetRange = `${cfg.sheetName}!${cfg.syncColumnLetter}${rowNumber}`;
      try {
        await sheets.spreadsheets.values.update({
          spreadsheetId: cfg.spreadsheetId,
          range: targetRange,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[cfg.syncWriteBackValue]] },
        });
      } catch (updateErr: unknown) {
        const errorMessage = `CRITICAL: Created issue ${issueUrl} for row ${rowNumber}, but failed to update the spreadsheet. Manual fix is required to prevent duplicate creation.`;
        core.error(errorMessage);
        core.setFailed(
          updateErr instanceof Error ? updateErr : String(updateErr),
        );
        return { processed: 1, created: 0, skipped: 0, failed: 1 };
      }
      return { processed: 1, created: 1, skipped: 0, failed: 0, issueUrl };
    } else {
      core.info(`[dry_run] Create issue: ${title}`);
      return { processed: 1, created: 1, skipped: 0, failed: 0 };
    }
  } catch (err: unknown) {
    core.warning(
      `Error processing row ${rowNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { processed: 1, created: 0, skipped: 0, failed: 1 };
  }
}

async function main() {
  core.info("spreadsheet-to-issue-action: start");

  const cfg = parseConfig(process.env);

  // Google Sheets client
  const auth = new OAuth2Client();
  auth.setCredentials({ access_token: cfg.accessToken });
  const sheets: sheets_v4.Sheets = sheetsApi({ version: "v4", auth });

  // Fetch values
  const range = `${cfg.sheetName}!${cfg.readRange}`;
  const getRes = await sheets.spreadsheets.values.get({
    spreadsheetId: cfg.spreadsheetId,
    range,
  });
  const values: unknown[][] = getRes.data.values || [];

  const { startColIndex, startRowNumber } = parseA1Start(cfg.readRange);
  const octokit = github.getOctokit(cfg.githubToken);

  const { processed, created, skipped, failed, createdUrls } =
    await processRows(
      cfg,
      values,
      startColIndex,
      startRowNumber,
      sheets,
      octokit,
    );

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
  core.setFailed(err instanceof Error ? err : String(err));
});
