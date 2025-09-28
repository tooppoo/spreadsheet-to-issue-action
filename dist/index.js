"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const github = __importStar(require("@actions/github"));
const mustache_1 = __importDefault(require("mustache"));
const google_auth_library_1 = require("google-auth-library");
const sheets_1 = require("@googleapis/sheets");
// Summaryに含めるURL件数の上限
const MAX_URLS_IN_SUMMARY = 100;
function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}
function isLabelObject(v) {
    return (!!v &&
        typeof v === "object" &&
        typeof v.name === "string");
}
function parseLabels(input) {
    if (!input)
        return undefined;
    const trimmed = input.trim();
    if (!trimmed)
        return undefined;
    // Try JSON parse only when the input looks like a JSON array
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr)) {
                // Convert objects to their name; keep only valid strings
                return arr.flatMap((v) => {
                    if (typeof v === "string")
                        return [v];
                    if (isLabelObject(v))
                        return [v.name];
                    core.warning(`Invalid label format in JSON array, skipping value: ${JSON.stringify(v)}`);
                    return [];
                });
            }
            else {
                // JSONとしては有効だが配列ではない
                core.warning(`Labels input was valid JSON but not an array, falling back to CSV. Input: ${trimmed}`);
            }
        }
        catch (e) {
            core.warning(`Could not parse labels input as JSON array, falling back to CSV. Error: ${e instanceof Error ? e.message : String(e)}`);
            // fallthrough to CSV
        }
    }
    // 入力がオブジェクト風のJSONの場合も、配列ではない旨を警告してCSVにフォールバック
    else if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            JSON.parse(trimmed);
            core.warning(`Labels input was valid JSON but not an array, falling back to CSV. Input: ${trimmed}`);
        }
        catch (e) {
            core.warning(`Could not parse labels input as JSON, falling back to CSV. Error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
function colLetterToIndex(letter) {
    // 'A' -> 0, 'B' -> 1 ... 'Z' -> 25, 'AA' -> 26
    let result = 0;
    for (const ch of letter.toUpperCase()) {
        const v = ch.charCodeAt(0) - 64; // A=1
        if (v < 1 || v > 26)
            throw new Error(`Invalid column letter: ${letter}`);
        result = result * 26 + v;
    }
    return result - 1;
}
function safeGet(env, key, def) {
    const v = env[key];
    if (v === undefined || v === "") {
        return def === undefined ? "" : def;
    }
    return v;
}
// 共通の数値入力パーサー（整数）
function getIntFromEnv(env, key, defaultValue, onNaN) {
    const input = safeGet(env, key, String(defaultValue));
    const value = parseInt(input, 10);
    if (Number.isNaN(value)) {
        return onNaN ? onNaN(String(input)) : defaultValue;
    }
    return value;
}
// Parse the start reference of an A1 range (e.g. 'C5:F' -> { startColIndex: 2, startRowNumber: 5 })
function parseA1Start(a1) {
    const trimmed = a1.trim();
    const firstRef = trimmed.split(":")[0]; // e.g. 'C5'
    // Match the entire ref: optional $ then letters, optional $ then digits
    const m = firstRef.match(/^\$?([A-Za-z]+)\$?(\d+)?$/);
    if (!m) {
        throw new Error(`READ_RANGE must start with a column reference (e.g., 'A:Z', 'C5:F'). Given: '${a1}'`);
    }
    const letters = m[1];
    const digits = m[2] ? parseInt(m[2], 10) : 1;
    return { startColIndex: colLetterToIndex(letters), startRowNumber: digits };
}
function parseConfig(env) {
    const accessToken = env.GOOGLE_OAUTH_ACCESS_TOKEN || env.ACCESS_TOKEN || "";
    if (!accessToken) {
        throw new Error("Neither GOOGLE_OAUTH_ACCESS_TOKEN nor ACCESS_TOKEN were found. Ensure you run google-github-actions/auth@v2 with token_format: 'access_token' and that the token is available as an environment variable.");
    }
    const spreadsheetId = safeGet(env, "SPREADSHEET_ID");
    const sheetName = safeGet(env, "SHEET_NAME");
    const readRange = safeGet(env, "READ_RANGE", "A:Z");
    const dataStartRow = getIntFromEnv(env, "DATA_START_ROW", 2, () => 2);
    if (dataStartRow < 1) {
        throw new Error(`data_start_row must be a positive integer, but got ${dataStartRow}.`);
    }
    const truthyJson = safeGet(env, "BOOLEAN_TRUTHY_VALUES", '["TRUE","true","True","1","はい","済"]');
    let truthyValues;
    try {
        const parsed = JSON.parse(truthyJson);
        if (!Array.isArray(parsed))
            throw new Error("Input is not a JSON array.");
        truthyValues = parsed.map((s) => String(s));
    }
    catch (e) {
        throw new Error(`'boolean_truthy_values' must be a valid JSON array. Input: ${truthyJson}. Error: ${e instanceof Error ? e.message : String(e)}`);
    }
    const titleTemplate = safeGet(env, "TITLE_TEMPLATE");
    const bodyTemplate = safeGet(env, "BODY_TEMPLATE");
    const syncColumnLetter = safeGet(env, "SYNC_COLUMN");
    const labelsInput = safeGet(env, "LABELS", "");
    const labels = parseLabels(labelsInput);
    const maxIssuesPerRun = getIntFromEnv(env, "MAX_ISSUES_PER_RUN", 10, (input) => {
        core.warning(`Invalid 'max_issues_per_run' input: '${input}'. Treating as unlimited.`);
        return 0; // 無制限を表す扱い（cfg.maxIssuesPerRun > 0 で判断）
    });
    const rateLimitDelay = getIntFromEnv(env, "RATE_LIMIT_DELAY", 1000, (input) => {
        core.warning(`Invalid 'rate_limit_delay' input: '${input}'. Using default 1000ms.`);
        return 1000;
    });
    const dryRun = safeGet(env, "DRY_RUN", "false").toLowerCase() === "true";
    const githubToken = safeGet(env, "GITHUB_TOKEN");
    const syncWriteBackValue = safeGet(env, "SYNC_WRITE_BACK_VALUE", "TRUE");
    // 必須入力を一括検証して不足分をまとめて通知
    const requiredInputs = {
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
async function processRows(cfg, values, startColIndex, startRowNumber, sheets, octokit) {
    const now = new Date().toISOString();
    let processed = 0;
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const createdUrls = [];
    const { owner, repo } = github.context.repo;
    const syncColIndex = colLetterToIndex(cfg.syncColumnLetter);
    const startRowIndex = Math.max(0, cfg.dataStartRow - startRowNumber);
    const limit = cfg.maxIssuesPerRun > 0 ? cfg.maxIssuesPerRun : Number.MAX_SAFE_INTEGER;
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
        }
        else if (!warnedSyncOutOfRange) {
            core.warning(`SYNC_COLUMN (${cfg.syncColumnLetter}) is outside READ_RANGE (${cfg.readRange}). Existing sync flags cannot be read; rows will be treated as unsynced.`);
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
        if (result.issueUrl && createdUrls.length < MAX_URLS_IN_SUMMARY)
            createdUrls.push(result.issueUrl);
        if (cfg.rateLimitDelay > 0)
            await sleep(cfg.rateLimitDelay);
    }
    return { processed, created, skipped, failed, createdUrls };
}
// 1行分の処理を担当（テンプレートのレンダリング → Issue作成 → シート書き戻し）
async function processSingleRow(args) {
    const { cfg, now, owner, repo, sheets, octokit, rowValues, startColIndex, rowNumber, } = args;
    // 行マップを生成
    const rowMap = {};
    for (let c = 0; c < rowValues.length; c++) {
        const letter = columnNumberToLetters(startColIndex + c);
        rowMap[letter] = String(rowValues[c] ?? "");
    }
    // テンプレートレンダリング
    const content = renderIssueContent(cfg, rowMap, rowNumber, now);
    if (!content) {
        core.info(`Skipping row ${rowNumber}: empty title after rendering`);
        return { processed: 0, created: 0, skipped: 1, failed: 0 };
    }
    if (cfg.dryRun) {
        core.info(`[dry_run] Create issue: ${content.title}`);
        return { processed: 1, created: 1, skipped: 0, failed: 0 };
    }
    // 行単位で復旧可能なエラー: Issue 作成失敗のみ捕捉して継続
    let issueUrl;
    try {
        issueUrl = await createIssue(octokit, {
            owner,
            repo,
            title: content.title,
            body: content.body,
            labels: cfg.labels,
        });
    }
    catch (err) {
        core.warning(`Error creating issue for row ${rowNumber}: ${err instanceof Error ? err.message : String(err)}`);
        return { processed: 1, created: 0, skipped: 0, failed: 1 };
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
    }
    catch (updateErr) {
        const errorMessage = `CRITICAL: Created issue ${issueUrl} for row ${rowNumber}, but failed to update the spreadsheet. Manual fix is required to prevent duplicate creation.`;
        core.error(errorMessage);
        // アクション全体を失敗させるため、エラーを再スロー
        throw updateErr instanceof Error ? updateErr : new Error(String(updateErr));
    }
    return { processed: 1, created: 1, skipped: 0, failed: 0, issueUrl };
}
async function main() {
    core.info("spreadsheet-to-issue-action: start");
    const cfg = parseConfig(process.env);
    // Google Sheets client
    const auth = new google_auth_library_1.OAuth2Client();
    auth.setCredentials({ access_token: cfg.accessToken });
    const sheets = (0, sheets_1.sheets)({ version: "v4", auth });
    // Fetch values
    const range = `${cfg.sheetName}!${cfg.readRange}`;
    const getRes = await sheets.spreadsheets.values.get({
        spreadsheetId: cfg.spreadsheetId,
        range,
    });
    const values = getRes.data.values || [];
    const { startColIndex, startRowNumber } = parseA1Start(cfg.readRange);
    const octokit = github.getOctokit(cfg.githubToken);
    const { processed, created, skipped, failed, createdUrls } = await processRows(cfg, values, startColIndex, startRowNumber, sheets, octokit);
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
function columnNumberToLetters(index) {
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
function renderIssueContent(cfg, row, rowNumber, now) {
    const context = { row, rowIndex: rowNumber, now };
    const title = mustache_1.default.render(cfg.titleTemplate, context);
    const body = mustache_1.default.render(cfg.bodyTemplate, context);
    if (title.trim().length === 0)
        return null;
    return { title, body };
}
// GitHub Issue を作成してURLを返す
async function createIssue(octokit, args) {
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
async function writeBackToSheet(sheets, args) {
    const targetRange = `${args.sheetName}!${args.syncColumnLetter}${args.rowNumber}`;
    await sheets.spreadsheets.values.update({
        spreadsheetId: args.spreadsheetId,
        range: targetRange,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[args.value]] },
    });
}
main().catch((err) => {
    core.setFailed(err instanceof Error ? err : String(err));
});
