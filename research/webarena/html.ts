/**
 * A static HTML report of a run directory: DIR/index.html and one page per task in its folder (DIR/ID/ID.html), with
 * the plan, every step, its screenshot (a run made with WEBHAND_SCREENSHOTS=1), and links to the task's files. The
 * screens are slides side by side, one to a width, each followed by what the log holds before the next one, and each
 * with a number above them: the step's, 0 for the first screen, 再 for one that starts again. A task's page links only
 * within its folder, apart from the way back to the index.
 *
 * Of eval_result.json only the top-level score and status are shown (through report.ts); the file is linked, for a
 * person to open. Where a run went wrong is not judged here: DIR/notes.json, written by whoever looked at the
 * logs, adds that, including which step met each item of a plan. Everything from the logs is page text or model output, so it is escaped.
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
  plan?: PlanCheck[];
}

/** Whether one item of an attempt's plan was met, and on which slide: a step's number, or "再" for the restart screen. */
interface PlanCheck {
  attempt: number;
  item: number;
  state: keyof typeof STATES;
  step?: number | "再";
  evidence?: string;
}

const STATES = { met: "達成", unmet: "未達", unknown: "未確認" };

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
.wrap{overflow-x:auto}.mute{color:var(--mute)}code{word-break:break-all}img{display:block;max-width:100%;max-height:calc(100vh - 190px);border:1px solid var(--line)}
.box,.event,.step{border:1px solid var(--line);border-radius:4px;padding:8px 12px;margin:10px 0}.event{border-style:dashed}
.step{border-left:5px solid var(--line)}.step.ok{border-left-color:var(--ok)}.step.problem{border-left-color:var(--bad)}.step.after{border-left-color:var(--after)}
.strip a{display:inline-block;min-width:26px;text-align:center;border:1px solid var(--line);border-radius:3px;margin:2px;text-decoration:none;font-size:12px}
.strip a.ok{border-color:var(--ok)}.strip a.problem{border-color:var(--bad);color:var(--bad)}
.met{color:var(--ok);font-weight:bold}.unmet{color:var(--bad);font-weight:bold}.unknown{color:var(--mute)}
.strip a[aria-current]{background:var(--fg);color:var(--bg);font-weight:bold}
body.task{max-width:1600px}.nav{position:sticky;top:0;background:var(--bg);display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;padding:6px 0;z-index:1}
.nav .strip{flex-basis:100%;margin:0}.nav button{font:inherit;padding:4px 16px;cursor:pointer}.slider{display:flex;align-items:flex-start;overflow-x:auto;scroll-snap-type:x mandatory}
.slide{flex:0 0 100%;min-width:0;box-sizing:border-box;scroll-snap-align:start;padding:0 4px}.slide>:first-child{margin-top:0}.slide p{margin:4px 0}`;

/**
 * The buttons and the arrow keys move one slide, and the number of the slide on screen is marked; without scripts the
 * slider still scrolls sideways.
 */
const SLIDER_SCRIPT = `<script>
const slider = document.querySelector(".slider");
const at = () => Math.round(slider.scrollLeft / slider.clientWidth);
const show = () => {
  const id = slider.children[at()]?.id;
  for (const a of document.querySelectorAll(".nav .strip a")) {
    if (a.hash === "#" + id) a.setAttribute("aria-current", "step");
    else a.removeAttribute("aria-current");
  }
};
// A jump to a slide stops below the numbers, which stay on screen.
const fit = () => {
  const height = document.querySelector(".nav").offsetHeight + "px";
  for (const slide of slider.children) slide.style.scrollMarginTop = height;
};
const move = (by) => { slider.scrollLeft = (at() + by) * slider.clientWidth; };
for (const button of document.querySelectorAll("[data-move]")) button.onclick = () => move(Number(button.dataset.move));
addEventListener("keydown", (event) => {
  const by = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
  if (!by || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  move(by);
});
slider.addEventListener("scroll", show);
addEventListener("resize", () => { fit(); show(); });
fit();
show();
</script>`;

const NOTICE = `<p class="mute">ステップの色分けと判定は notes.json に書かれた内容で、実行ログを調べた人またはエージェントの推定です(notes.json がないタスクは判定なし)。eval_result.json は採点と状態だけを表示し、中身は読んでいません。画像には入力値が写り、HAR には Cookie が含まれるため、共有しないでください。</p>`;

const page = (title: string, body: string, kind = "") =>
  `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><style>${CSS}</style></head><body class="${kind}">${body}</body></html>\n`;

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
  const badPlan = notes.find(
    ([, note]) =>
      note.plan !== undefined &&
      !(Array.isArray(note.plan) && note.plan.every((x) => x && Object.hasOwn(STATES, x.state))),
  );
  if (badPlan) {
    throw new WebArenaError(
      `Invalid notes file ${file}: task ${badPlan[0]} needs "plan" as a list with "state" ${Object.keys(STATES).join("|")}`,
    );
  }
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
  if (x.type === "webarena_error_details") return `エラーの申告理由(回答には含めない): ${x.error_details}`;
  return null;
}

/** The id of the slide a check points at. */
const slideId = (check: PlanCheck) =>
  check.step === undefined ? null : check.step === "再" ? `r${check.attempt}` : `s${check.step}`;

/** An attempt's plan: a table with each item's verdict when the note has checks for it, else the list as written. */
function planHtml(x: Event, checks: PlanCheck[], ids: Set<string>): string {
  const items: string[] = (x.steps ?? []).map((s: unknown) => String(s).replace(/^\d+\. /, ""));
  const mine = checks.filter((check) => check.attempt === x.attempt);
  const reason = x.reason ? `<p>再計画の理由: ${e(x.reason)}</p>` : "";
  const title = `<b>計画(試行 ${e(x.attempt)})</b>${reason}`;
  if (!mine.length) return `<div class="event">${title}<ol>${items.map((s) => `<li>${e(s)}</li>`).join("")}</ol></div>`;
  const rows = items.map((item, index) => {
    const check = mine.find((one) => one.item === index + 1);
    const [what, ...condition] = item.split(/;\s*done when\s+/i);
    const id = check ? slideId(check) : null;
    const label = e(check?.step ?? "-");
    const at = id && ids.has(id) ? `<a href="#${e(id)}">${label}</a>` : label;
    const state = check?.state ?? "unknown";
    return `<tr><td>${index + 1}. ${e(what)}</td><td>${e(condition.join("; ") || "-")}</td><td class="${state}">${STATES[state]}</td><td class="strip">${at}</td><td>${e(check?.evidence)}</td></tr>`;
  });
  return `<div class="event">${title}<div class="wrap"><table><tr><th>計画</th><th>完了条件</th><th>判定(推定)</th><th>ステップ</th><th>根拠</th></tr>${rows.join("")}</table></div></div>`;
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
  const checks = note?.plan ?? [];
  const checked = (id: string) =>
    checks
      .filter((check) => slideId(check) === id)
      .map((check) => `<span class="${check.state}">計画 ${e(check.item)} ${STATES[check.state]}</span>`)
      .join(" ");
  // The slides a plan can link to: the plan comes first in the log, before they are made.
  const ids = new Set<string>(steps.map((x) => `s${x.step}`));
  for (const x of events) if (x.type === "screenshot" && x.after !== "action") ids.add(`r${x.attempt}`);
  // What comes before the first screen (the first plan) stays above the slider.
  const intro: string[] = [];
  const slides: { id: string; label: string; mark: string; title: string; html: string[] }[] = [];
  const add = (html: string) => (slides.at(-1)?.html ?? intro).push(html);
  for (const x of events) {
    if (x.type === "plan") {
      add(planHtml(x, checks, ids));
      continue;
    }
    if (x.type === "screenshot" && x.after !== "action") {
      const start = x.after === "start";
      const title = `画面(${start ? "開始" : "再開始"}、試行 ${x.attempt})`;
      // A note's "再" means an attempt's first restart screen; any later one gets its own id.
      const first = `r${x.attempt}`;
      const id = start ? "s0" : slides.some((slide) => slide.id === first) ? `${first}-${slides.length}` : first;
      const html = `<div class="event"><b>${e(title)}</b> ${checked(id)}${image(x.file)}</div>`;
      slides.push({ id, label: start ? "0" : "再", mark: "", title, html: [html] });
      continue;
    }
    if (x.type === "step") {
      const m = mark(x.step, note, firstBad);
      const result = changed.get(x.step);
      const change = result === true ? " / ページ変化あり" : result === false ? " / ページ変化なし" : "";
      const shot = shots.get(`${x.step}/${x.attempt}`);
      const html = `<div class="step ${m}"><p><b>ステップ ${e(x.step)}</b> (試行 ${e(x.attempt)}) ${e(MARK_LABEL[m])} ${e(x.operation)} ${e(firstLine(x.action))} ${checked(`s${x.step}`)}<br><span class="mute">選択: ${e(x.decided_by)} / 確信度 ${e(x.confidence)}${change}</span></p>${shot ? image(shot) : ""}</div>`;
      const title = firstLine(x.action);
      slides.push({ id: `s${e(x.step)}`, label: String(x.step), mark: m, title, html: [html] });
      continue;
    }
    const text = eventText(x);
    if (text !== null) add(`<div class="event mute">${e(text)}</div>`);
  }
  const strip = slides
    .map((x) => `<a class="${x.mark}" href="#${x.id}" title="${e(x.title)}">${e(x.label)}</a>`)
    .join("");
  const nav = `<div class="nav"><p class="strip">${strip}</p><button type="button" data-move="-1">← 前</button><button type="button" data-move="1">次 →</button><span class="mute">←→ キーや横スクロールでも移動できます</span></div>`;
  const sections = slides.map((x) => `<section class="slide" id="${x.id}">${x.html.join("")}</section>`);
  const flow = slides.length ? `${nav}<div class="slider">${sections.join("")}</div>${SLIDER_SCRIPT}` : "";
  const goal = events.find((x) => x.type === "run_start")?.goal ?? "";
  const response = join(taskDir, config.agent_response_file_name);
  const verdict = note
    ? `<p><b>${e(note.summary)}</b></p><p>${e(note.detail)}</p><p>想定どおりに進んだ範囲: <b>${note.ok_until === undefined ? "ずれたステップの指定なし" : `ステップ ${e(note.ok_until)} まで`}</b></p>`
    : `<p class="mute">判定なし</p>`;
  const files = [
    link(config.eval_result_file_name),
    link("webhand.jsonl"),
    link(config.agent_response_file_name),
    link(config.trace_file_name),
    link("webhand-screenshots", "スクリーンショット一覧"),
  ].join(" | ");
  const body = `<p><a href="${href(join(reportDir, "index.html"))}">← 一覧</a></p><h1>タスク ${row.task_id}</h1><div class="box"><b>タスク内容</b><p>${e(goal)}</p></div><div class="box"><p>採点: <b>${e(scoreText(row))}</b> / 実行側の申告: ${e(row.status)} / 試行 ${e(row.attempts)}</p>${verdict}</div><p>${files}</p>${existsSync(response) ? `<p class="mute">提出した回答: <code>${e(readFileSync(response, "utf8"))}</code></p>` : ""}${NOTICE}<h2>実行の流れ</h2>${intro.join("")}${flow}`;
  const shown = existsSync(join(taskDir, config.eval_result_file_name));
  const evalLink = shown ? link(config.eval_result_file_name, config.eval_result_file_name, reportDir) : "-";
  const range = note?.ok_until === undefined ? "-" : `ステップ ${e(note.ok_until)} まで`;
  const indexRow = `<tr><td><a href="${row.task_id}/${row.task_id}.html">${row.task_id}</a></td><td>${e(goal)}</td><td>${e(scoreText(row))}</td><td>${e(row.status)}</td><td>${note ? e(note.summary) : '<span class="mute">判定なし</span>'}</td><td>${range}</td><td>${evalLink}</td></tr>`;
  return { html: page(`タスク ${row.task_id}`, body, "task"), indexRow };
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
