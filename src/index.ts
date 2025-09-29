import * as core from "@actions/core";
import * as github from "@actions/github";
import Mustache from "mustache";
import { OAuth2Client } from "google-auth-library";
import { sheets_v4, sheets as sheetsApi } from "@googleapis/sheets";

type RowMap = Record<string, string>;

// Summaryに含めるURL件数の上限
const MAX_URLS_IN_SUMMARY = 100;

// Mustache テンプレートに渡すコンテキスト型
type TemplateContext = {
  readonly row: RowMap;
  readonly rowIndex: number;
  readonly now: string;
};

type IssueContent = {
  title: string;
  body: string;
};

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function isLabelObject(v: unknown): v is { name: string } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { name?: unknown }).name === "string"
  );
}

function parseLabels(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  // Try JSON parse only when the input looks like a JSON array
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        // Convert objects to their name; keep only valid strings
        return arr.flatMap((v): string[] => {
          if (typeof v === "string") return [v];
          if (isLabelObject(v)) return [v.name];
          core.warning(
            `Invalid label format in JSON array, skipping value: ${JSON.stringify(v)}`,
          );
          return [];
        });
      } else {
        // JSONとしては有効だが配列ではない
        core.warning(
          `Labels input was valid JSON but not an array, falling back to CSV. Input: ${trimmed}`,
        );
      }
    } catch (e) {
      core.warning(
        `Could not parse labels input as JSON array, falling back to CSV. Error: ${e instanceof Error ? e.message : String(e)}`,
      );
      // fallthrough to CSV
    }
  }
  // 入力がオブジェクト風のJSONの場合も、配列ではない旨を警告してCSVにフォールバック
  else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      JSON.parse(trimmed);
      core.warning(
        `Labels input was valid JSON but not an array, falling back to CSV. Input: ${trimmed}`,
      );
    } catch (e) {
      core.warning(
        `Could not parse labels input as JSON, falling back to CSV. Error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
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

function getInputRequired(name: string, pretty?: string): string {
  const v = core.getInput(name, { required: false }).trim();
  if (!v) {
    throw new Error(`Required input '${pretty ?? name}' is missing.`);
  }
  return v;
}

function getInputOptional(name: string, def?: string): string {
  const v = core.getInput(name, { required: false });
  if (v === undefined || v === "") return def ?? "";
  return v;
}

// 共通の数値入力パーサー（整数）
function getIntFromInput(
  name: string,
  defaultValue: number,
  onNaN?: (input: string) => number,
): number {
  const input = getInputOptional(name, String(defaultValue));
  const value = parseInt(input, 10);
  if (Number.isNaN(value)) {
    return onNaN ? onNaN(String(input)) : defaultValue;
  }
  return value;
}

// Parse the start reference of an A1 range (e.g. 'C5:F' -> { startColIndex: 2, startRowNumber: 5 })
function parseA1Start(a1: string): {
  startColIndex: number;
  startRowNumber: number;
} {
  const trimmed = a1.trim();
  const firstRef = trimmed.split(":")[0]; // e.g. 'C5'
  // Match the entire ref: optional $ then letters, optional $ then digits
  const m = firstRef.match(/^\$?([A-Za-z]+)\$?(\d+)?$/);
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
  labels: string[] | undefined;
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
      "Neither GOOGLE_OAUTH_ACCESS_TOKEN nor ACCESS_TOKEN were found. Ensure you run google-github-actions/auth@v2 with token_format: 'access_token' and that the token is available as an environment variable.",
    );
  }

  // Inputs are taken via @actions/core.getInput
  const spreadsheetId = getInputRequired("spreadsheet_id", "spreadsheet_id");
  const sheetName = getInputRequired("sheet_name", "sheet_name");
  const readRange = getInputOptional("read_range", "A:Z");
  const dataStartRow = getIntFromInput("data_start_row", 2, () => 2);
  if (dataStartRow < 1) {
    throw new Error(
      `data_start_row must be a positive integer, but got ${dataStartRow}.`,
    );
  }
  const truthyJson = getInputOptional(
    "boolean_truthy_values",
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

  const titleTemplate = getInputRequired("title_template", "title_template");
  const bodyTemplate = getInputRequired("body_template", "body_template");
  const syncColumnLetter = getInputRequired("sync_column", "sync_column");
  const labelsInput = getInputOptional("labels", "");
  const labels = parseLabels(labelsInput);
  const maxIssuesPerRun = getIntFromInput(
    "max_issues_per_run",
    10,
    (input) => {
      core.warning(
        `Invalid 'max_issues_per_run' input: '${input}'. Treating as unlimited.`,
      );
      return 0; // 無制限を表す扱い（cfg.maxIssuesPerRun > 0 で判断）
    },
  );
  const rateLimitDelay = getIntFromInput(
    "rate_limit_delay",
    1000,
    (input) => {
      core.warning(
        `Invalid 'rate_limit_delay' input: '${input}'. Using default 1000ms.`,
      );
      return 1000;
    },
  );
  const dryRun = getInputOptional("dry_run", "false").toLowerCase() === "true";
  const githubToken = getInputRequired("github_token", "github_token");
  const syncWriteBackValue = getInputOptional("sync_write_back_value", "TRUE");

  // 必須入力を一括検証して不足分をまとめて通知
  const requiredInputs: Record<string, string | undefined> = {
    GITHUB_TOKEN: githubToken,
    SPREADSHEET_ID: spreadsheetId,
    SHEET_NAME: sheetName,
    TITLE_TEMPLATE: titleTemplate,
    BODY_TEMPLATE: bodyTemplate,
    SYNC_COLUMN: syncColumnLetter,
  };
  const missingInputs = Object.entries(requiredInputs)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missingInputs.length > 0) {
    throw new Error(`Required inputs are missing: ${missingInputs.join(", ")}`);
  }

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
  planned: number;
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
  let planned = 0;
  const createdUrls: string[] = [];
  const { owner, repo } = github.context.repo;
  const syncColIndex = colLetterToIndex(cfg.syncColumnLetter);
  const startRowIndex = Math.max(0, cfg.dataStartRow - startRowNumber);
  const limit =
    cfg.maxIssuesPerRun > 0 ? cfg.maxIssuesPerRun : Number.MAX_SAFE_INTEGER;

  let warnedSyncOutOfRange = false;
  for (let i = startRowIndex; i < values.length; i++) {
    const countForLimit = cfg.dryRun ? planned : created;
    if (countForLimit >= limit) {
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
    planned += result.planned;
    if (result.issueUrl && createdUrls.length < MAX_URLS_IN_SUMMARY)
      createdUrls.push(result.issueUrl);

    if (cfg.rateLimitDelay > 0) await sleep(cfg.rateLimitDelay);
  }

  return { processed, created, skipped, failed, planned, createdUrls };
}

// 1行分の処理を担当（テンプレートのレンダリング → Issue作成 → シート書き戻し）
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
  planned: number;
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
  const content = renderIssueContent(cfg, rowMap, rowNumber, now);
  if (!content) {
    core.info(`Skipping row ${rowNumber}: empty title after rendering`);
    return { processed: 0, created: 0, skipped: 1, failed: 0, planned: 0 };
  }

  if (cfg.dryRun) {
    core.info(`[dry_run] Create issue: ${content.title}`);
    return { processed: 1, created: 0, skipped: 0, failed: 0, planned: 1 };
  }

  // 行単位で復旧可能なエラー: Issue 作成失敗のみ捕捉して継続
  let issueUrl: string;
  try {
    issueUrl = await createIssue(octokit, {
      owner,
      repo,
      title: content.title,
      body: content.body,
      labels: cfg.labels,
    });
  } catch (err: unknown) {
    core.warning(
      `Error creating issue for row ${rowNumber}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { processed: 1, created: 0, skipped: 0, failed: 1, planned: 0 };
  }

  // クリティカルエラー: 書き戻し失敗時は即時中断のため再throw
  try {
    await writeBackToSheet(sheets, {
      spreadsheetId: cfg.spreadsheetId,
      sheetName: cfg.sheetName,
      syncColumnLetter: cfg.syncColumnLetter,
      rowNumber,
      value: cfg.syncWriteBackValue,
    });
  } catch (updateErr: unknown) {
    const errorMessage = `CRITICAL: Created issue ${issueUrl} for row ${rowNumber}, but failed to update the spreadsheet. Manual fix is required to prevent duplicate creation.`;
    core.error(errorMessage);
    // アクション全体を失敗させるため、エラーを再スロー
    throw updateErr instanceof Error ? updateErr : new Error(String(updateErr));
  }

  return { processed: 1, created: 1, skipped: 0, failed: 0, planned: 0, issueUrl };
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

  const { processed, created, skipped, failed, planned, createdUrls } =
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
    `Planned: ${planned}`,
    "",
    ...createdUrls.map((u) => `- ${u}`),
  ].join("\n");

  core.setOutput("processed_count", String(processed));
  core.setOutput("created_count", String(created));
  core.setOutput("skipped_count", String(skipped));
  core.setOutput("failed_count", String(failed));
  core.setOutput("planned_count", String(planned));
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

// Issueのタイトル/本文をテンプレートから生成
function renderIssueContent(
  cfg: Config,
  row: RowMap,
  rowNumber: number,
  now: string,
): IssueContent | null {
  const context: TemplateContext = { row, rowIndex: rowNumber, now };
  const title = Mustache.render(cfg.titleTemplate, context);
  const body = Mustache.render(cfg.bodyTemplate, context);
  if (title.trim().length === 0) return null;
  return { title, body };
}

// GitHub Issue を作成してURLを返す
async function createIssue(
  octokit: ReturnType<typeof github.getOctokit>,
  args: {
    owner: string;
    repo: string;
    title: string;
    body: string;
    labels?: string[];
  },
): Promise<string> {
  const res = await octokit.rest.issues.create({
    owner: args.owner,
    repo: args.repo,
    title: args.title,
    body: args.body,
    labels: args.labels,
  });
  return res.data.html_url;
}

// シートへ同期待ち済みマークを書き戻す
async function writeBackToSheet(
  sheets: sheets_v4.Sheets,
  args: {
    spreadsheetId: string;
    sheetName: string;
    syncColumnLetter: string;
    rowNumber: number;
    value: string;
  },
): Promise<void> {
  const targetRange = `${args.sheetName}!${args.syncColumnLetter}${args.rowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: args.spreadsheetId,
    range: targetRange,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[args.value]] },
  });
}

main().catch((err: unknown) => {
  core.setFailed(err instanceof Error ? err : String(err));
});
