/**
 * A static HTML report of a run directory: DIR/index.html and one page per task in its folder (DIR/ID/ID.html), with
 * the plan, every step, its screenshot (a run made with WEBHAND_SCREENSHOTS=1), and links to the task's files. A
 * task's page links only within its folder, apart from the way back to the index.
 *
 * Of eval_result.json only the top-level score and status are shown (through report.ts); the file is linked, for a
 * person to open. Where a run went wrong is not judged here: DIR/notes.json, written by whoever looked at the
 * logs, adds that. Everything from the logs is page text or model output, so it is escaped.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { readJsonLines } from "../../src/core/fs.ts";
import type { WebArenaConfig } from "./config.ts";
import { summarizeRunDir } from "./report.ts";
import { WebArenaError } from "./sites.ts";

// biome-ignore lint/suspicious/noExplicitAny: log lines are untyped JSON.
type Event = Record<string, any>;

/** What a person or the host agent found in one task's records. */
interface Note {
  /** The last step that went as planned; the steps after it are marked. Left out when no step went wrong. */
  ok_until?: number;
  /** One line: where and how it went wrong. */
  summary: string;
  detail?: string;
}

type Row = ReturnType<typeof summarizeRunDir>["tasks"][number];

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);
const e = escapeHtml;
const firstLine = (value: unknown) =>
  String(value ?? "")
    .trim()
    .split("\n")[0]
    .trim()
    .slice(0, 100);
const failed = (row: Row) => !(row.eval_status === "success" || (row.eval_status === null && row.score === 1));
const scoreText = (row: Row) =>
  row.eval_status === null && row.score === null ? "未採点" : `${row.eval_status ?? "?"} (score ${row.score ?? "?"})`;

const CSS = `:root{--bg:#fff;--fg:#1c1c1c;--mute:#666;--line:#ddd;--ok:#2e7d32;--bad:#c62828;--after:#777}
@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#e8e8e8;--mute:#999;--line:#333;--ok:#6fcf75;--bad:#ff7b72}}
body{background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,sans-serif;max-width:1200px;margin:0 auto;padding:16px}
a{color:inherit}table{border-collapse:collapse;width:100%}td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.wrap{overflow-x:auto}.mute{color:var(--mute)}code{word-break:break-all}img{max-width:520px;width:100%;border:1px solid var(--line)}
.box,.event,.step{border:1px solid var(--line);border-radius:4px;padding:8px 12px;margin:10px 0}.event{border-style:dashed}
.step{border-left:5px solid var(--line)}.step.ok{border-left-color:var(--ok)}.step.problem{border-left-color:var(--bad)}.step.after{border-left-color:var(--after)}
.strip a{display:inline-block;min-width:26px;text-align:center;border:1px solid var(--line);border-radius:3px;margin:2px;text-decoration:none;font-size:12px}
.strip a.ok{border-color:var(--ok)}.strip a.problem{border-color:var(--bad);color:var(--bad)}`;

const NOTICE = `<p class="mute">ステップの色分けと判定は notes.json に書かれた内容で、実行ログを調べた人またはエージェントの推定です(notes.json がないタスクは判定なし)。eval_result.json は採点と状態だけを表示し、中身は読んでいません。画像には入力値が写り、HAR には Cookie が含まれるため、共有しないでください。</p>`;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><style>${CSS}</style></head><body>${body}</body></html>\n`;

function readNotes(file: string): Record<string, Note> {
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new WebArenaError(`Invalid notes file ${file}: ${(error as Error).message}`);
  }
  const notes = Object.entries((parsed ?? {}) as Record<string, Note>);
  const bad = notes.find(([, note]) => typeof note?.summary !== "string");
  if (bad) throw new WebArenaError(`Invalid notes file ${file}: task ${bad[0]} needs a "summary" string`);
  return Object.fromEntries(notes);
}

/** How a step is coloured: by the note's ok_until, else not at all. */
function mark(step: number, note: Note | undefined, firstBad: number | undefined): "ok" | "problem" | "after" | "" {
  if (note?.ok_until === undefined) return "";
  if (step <= note.ok_until) return "ok";
  return step === firstBad ? "problem" : "after";
}

const MARK_LABEL = { ok: "想定どおり", problem: "ずれ", after: "ずれの後", "": "" };

function eventText(x: Event): string | null {
  if (x.type === "escalation") return `停止: ${x.reason} — ${x.detail}`;
  if (x.type === "attempt_end") return `試行 ${x.attempt} 終了: ${x.outcome} — ${x.reason}`;
  if (x.type === "answer") return `エージェントが回答して続行(${x.after} の後)`;
  if (x.type === "not_visible") return `Jev: 必要な要素が一覧にない(${x.wanted})`;
  if (x.type === "repeat_refused") return `繰り返しのクリックを実行しなかった: ${x.target}`;
  if (x.type === "run_end") return `終了: ${x.status} — ${x.reason}`;
  return null;
}

function taskPage(
  row: Row,
  taskDir: string,
  reportDir: string,
  events: Event[],
  note: Note | undefined,
  config: WebArenaConfig,
) {
  // Relative to the page that holds the link: the task's page in its own folder, or the index above it.
  const href = (path: string, from = taskDir) => e(relative(from, path).split("/").map(encodeURIComponent).join("/"));
  const link = (name: string, label = name, from = taskDir) => {
    const path = join(taskDir, name);
    return existsSync(path)
      ? `<a href="${href(path, from)}">${e(label)}</a>`
      : `<span class="mute">${e(label)}(なし)</span>`;
  };
  // Only the file's name is taken from the log, so a link never leaves the task's screenshot folder.
  const image = (file: unknown) => {
    const path = join(taskDir, "webhand-screenshots", basename(String(file)));
    return existsSync(path)
      ? `<a href="${href(path)}"><img loading="lazy" src="${href(path)}" alt="screenshot"></a>`
      : "";
  };
  const steps = events.filter((x) => x.type === "step");
  const changed = new Map(events.filter((x) => x.type === "step_result").map((x) => [x.step, x.page_changed]));
  const shots = new Map(events.filter((x) => x.type === "screenshot").map((x) => [`${x.step}/${x.attempt}`, x.file]));
  const firstBad = steps.find((x) => note?.ok_until !== undefined && x.step > note.ok_until)?.step;
  const flow = events.map((x) => {
    if (x.type === "plan") {
      const items = (x.steps ?? []).map((s: unknown) => `<li>${e(String(s).replace(/^\d+\. /, ""))}</li>`).join("");
      const reason = x.reason ? `<p>再計画の理由: ${e(x.reason)}</p>` : "";
      return `<div class="event"><b>計画(試行 ${e(x.attempt)})</b>${reason}<ol>${items}</ol></div>`;
    }
    if (x.type === "screenshot" && x.after !== "action") {
      return `<div class="event"><b>画面(${x.after === "start" ? "開始" : "再開始"}、試行 ${e(x.attempt)})</b><br>${image(x.file)}</div>`;
    }
    if (x.type === "step") {
      const m = mark(x.step, note, firstBad);
      const result = changed.get(x.step);
      const change = result === true ? " / ページ変化あり" : result === false ? " / ページ変化なし" : "";
      const shot = shots.get(`${x.step}/${x.attempt}`);
      return `<div class="step ${m}" id="s${e(x.step)}"><p><b>ステップ ${e(x.step)}</b> (試行 ${e(x.attempt)}) ${e(MARK_LABEL[m])} ${e(x.operation)} ${e(firstLine(x.action))}<br><span class="mute">選択: ${e(x.decided_by)} / 確信度 ${e(x.confidence)}${change}</span></p>${shot ? image(shot) : ""}</div>`;
    }
    const text = eventText(x);
    return text === null ? "" : `<div class="event mute">${e(text)}</div>`;
  });
  const goal = events.find((x) => x.type === "run_start")?.goal ?? "";
  const response = join(taskDir, config.agent_response_file_name);
  const verdict = note
    ? `<p><b>${e(note.summary)}</b></p><p>${e(note.detail)}</p><p>想定どおりに進んだ範囲: <b>${note.ok_until === undefined ? "ずれたステップの指定なし" : `ステップ ${e(note.ok_until)} まで`}</b></p>`
    : `<p class="mute">判定なし</p>`;
  const strip = steps
    .map(
      (x) =>
        `<a class="${mark(x.step, note, firstBad)}" href="#s${e(x.step)}" title="${e(firstLine(x.action))}">${e(x.step)}</a>`,
    )
    .join("");
  const files = [
    link(config.eval_result_file_name),
    link("webhand.jsonl"),
    link(config.agent_response_file_name),
    link(config.trace_file_name),
    link("webhand-screenshots", "スクリーンショット一覧"),
  ].join(" | ");
  const body = `<p><a href="${href(join(reportDir, "index.html"))}">← 一覧</a></p><h1>タスク ${row.task_id}</h1><div class="box"><b>タスク内容</b><p>${e(goal)}</p></div><div class="box"><p>採点: <b>${e(scoreText(row))}</b> / 実行側の申告: ${e(row.status)} / 試行 ${e(row.attempts)}</p>${verdict}<p class="strip">${strip}</p></div><p>${files}</p>${existsSync(response) ? `<p class="mute">提出した回答: <code>${e(readFileSync(response, "utf8"))}</code></p>` : ""}${NOTICE}<h2>実行の流れ</h2>${flow.join("")}`;
  const shown = existsSync(join(taskDir, config.eval_result_file_name));
  const evalLink = shown ? link(config.eval_result_file_name, config.eval_result_file_name, reportDir) : "-";
  const range = note?.ok_until === undefined ? "-" : `ステップ ${e(note.ok_until)} まで`;
  const indexRow = `<tr><td><a href="${row.task_id}/${row.task_id}.html">${row.task_id}</a></td><td>${e(goal)}</td><td>${e(scoreText(row))}</td><td>${e(row.status)}</td><td>${note ? e(note.summary) : '<span class="mute">判定なし</span>'}</td><td>${range}</td><td>${evalLink}</td></tr>`;
  return { html: page(`タスク ${row.task_id}`, body), indexRow };
}

/** Writes DIR/index.html and DIR/ID/ID.html, and returns the index's path. Failed and unscored tasks are listed first. */
export function writeHtmlReport(outputDir: string, config: WebArenaConfig, notesFile?: string | null): string {
  const report = summarizeRunDir(outputDir, config);
  const reportDir = report.output_dir;
  const notes = readNotes(notesFile ? resolve(notesFile) : join(reportDir, "notes.json"));
  const write = (name: string, text: string) => writeFileSync(join(reportDir, name), text, { mode: 0o600 });
  const rows = [...report.tasks].sort((a, b) => Number(failed(b)) - Number(failed(a)) || a.task_id - b.task_id);
  const index = rows.map((row) => {
    const taskDir = join(report.output_dir, String(row.task_id));
    const events = row.log_path ? (readJsonLines(readFileSync(row.log_path, "utf8")) as Event[]) : [];
    const made = taskPage(row, taskDir, reportDir, events, notes[row.task_id], config);
    write(join(String(row.task_id), `${row.task_id}.html`), made.html);
    return made.indexRow;
  });
  const summary = `全 ${report.total} 件: 成功 ${report.success} / 失敗 ${report.failure} / 採点エラー ${report.error} / 未採点 ${report.unevaluated}(webarena_verified_score。tasks/ の verify() とは別の指標)`;
  write(
    "index.html",
    page(
      "WebArena レポート",
      `<h1>WebArena レポート</h1><p><code>${e(report.output_dir)}</code></p><p>${e(summary)}</p>${NOTICE}<div class="wrap"><table><tr><th>ID</th><th>タスク内容</th><th>採点</th><th>申告</th><th>判定(推定)</th><th>想定どおりの範囲</th><th>eval_result.json</th></tr>${index.join("")}</table></div>`,
    ),
  );
  return join(reportDir, "index.html");
}
