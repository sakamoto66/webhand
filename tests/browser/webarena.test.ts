import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  defaultConfig,
  inspectSiteConfigs,
  loadConfig,
  renderTaskUrl,
  resolveAutoLoginTargets,
} from "../../research/webarena/config.ts";
import { listTasksPublic, loadTaskPublic } from "../../research/webarena/dataset.ts";
import { summarizeRunDir } from "../../research/webarena/report.ts";
import { validateAgentResponse } from "../../research/webarena/response.ts";
import { WebArenaError } from "../../research/webarena/sites.ts";
import { run as runWebArena } from "../../research/webarena.ts";
import { CliExit } from "../../src/commands/context.ts";
import type { HarDocument } from "../../src/har/index.ts";
import { stopHarRecorder } from "../../src/har/session.ts";
import * as session from "../../src/storage/session.ts";
import { tmpPath } from "../helpers.ts";
import { isolate, ScriptedJev } from "../jev.ts";

let workDir: string;

async function wa(...argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runWebArena(argv, {
    out: (text) => {
      out += text;
    },
    err: () => {},
  });
  return { code, out };
}

async function waExit(...argv: string[]): Promise<string> {
  try {
    await wa(...argv);
  } catch (error) {
    if (error instanceof CliExit) return error.message;
    throw error;
  }
  throw new Error(`Expected ${argv.join(" ")} to stop with CliExit`);
}

describe("research/webarena-config", () => {
  beforeEach(() => {
    workDir = tmpPath();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("loads config, renders placeholders, and strips eval/expected from tasks", () => {
    const configPath = join(workDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        environments: {
          __SHOPPING_ADMIN__: {
            urls: ["http://127.0.0.1:7780/admin/"],
            use_header_login: true,
            credentials: { username: "admin", password: "secret" },
          },
          shopping: {
            urls: ["http://127.0.0.1:7770"],
            use_header_login: false,
            credentials: { email: "emma.lopez@gmail.com", password: "Password.123" },
          },
          reddit: {
            urls: ["http://127.0.0.1:9999"],
            use_header_login: false,
            extra: { auto_login_header: { name: "X-Custom-Login", value: "user1:pw" } },
          },
        },
      }),
    );
    const { config, path } = loadConfig(configPath);
    expect(path).toBe(configPath);
    expect(renderTaskUrl("__SHOPPING_ADMIN__/sales/order/", config)).toBe("http://127.0.0.1:7780/admin/sales/order/");

    const targets = resolveAutoLoginTargets(config, ["shopping_admin", "shopping", "reddit", "shopping_admin"]);
    expect(targets).toEqual([
      {
        mode: "header",
        site: "shopping_admin",
        url: "http://127.0.0.1:7780/admin",
        header: { name: "X-M2-Admin-Auto-Login", value: "admin:secret" },
      },
      {
        mode: "form",
        site: "shopping",
        loginUrl: "http://127.0.0.1:7770/customer/account/login",
        userSelector: 'input#email[name="login[username]"], input[name="login[username]"]',
        passwordSelector: 'input#pass[name="login[password]"], input[name="login[password]"]',
        submitSelector: 'button#send2, form#login-form button[type="submit"]',
        user: "emma.lopez@gmail.com",
        password: "Password.123",
      },
      {
        mode: "header",
        site: "reddit",
        url: "http://127.0.0.1:9999",
        header: { name: "X-Custom-Login", value: "user1:pw" },
      },
    ]);

    const unsupportedPath = join(workDir, "bad-header.json");
    writeFileSync(
      unsupportedPath,
      JSON.stringify({
        environments: {
          shopping: { urls: ["http://127.0.0.1:7770"], use_header_login: true },
        },
      }),
    );
    expect(() => resolveAutoLoginTargets(loadConfig(unsupportedPath).config, ["shopping"])).toThrow(WebArenaError);

    const datasetPath = join(workDir, "dataset.json");
    writeFileSync(
      datasetPath,
      JSON.stringify([
        {
          task_id: 108,
          sites: ["shopping_admin"],
          start_urls: ["__SHOPPING_ADMIN__/sales/order/"],
          intent: "Get top product",
          intent_template_id: 279,
          eval: [{ evaluator: "AgentResponseEvaluator", expected: { retrieved_data: ["SECRET_ANSWER"] } }],
        },
      ]),
    );
    const pub = loadTaskPublic(datasetPath, 108, config);
    expect(pub).toEqual({
      task_id: 108,
      sites: ["shopping_admin"],
      start_urls: ["http://127.0.0.1:7780/admin/sales/order/"],
      intent: "Get top product",
      intent_template_id: 279,
    });
    expect(JSON.stringify(pub)).not.toContain("SECRET_ANSWER");
    expect("eval" in pub).toBe(false);
  });

  test("validates FinalAgentResponse schemas strictly", () => {
    expect(
      validateAgentResponse({
        taskType: "retrieve",
        status: "success",
        retrievedDataRaw: '[{"month":"Jan","count":12}]',
        errorDetails: null,
      }),
    ).toEqual({
      task_type: "RETRIEVE",
      status: "SUCCESS",
      retrieved_data: [{ month: "Jan", count: 12 }],
    });

    expect(
      validateAgentResponse({
        taskType: "NAVIGATE",
        status: "SUCCESS",
        retrievedDataRaw: null,
        errorDetails: null,
      }),
    ).toEqual({
      task_type: "NAVIGATE",
      status: "SUCCESS",
    });

    expect(
      validateAgentResponse({
        taskType: "MUTATE",
        status: "NOT_FOUND_ERROR",
        retrievedDataRaw: null,
        errorDetails: "Order #999 does not exist",
      }),
    ).toEqual({
      task_type: "MUTATE",
      status: "NOT_FOUND_ERROR",
      error_details: "Order #999 does not exist",
    });

    expect(() =>
      validateAgentResponse({ taskType: "RETRIEVE", status: "SUCCESS", retrievedDataRaw: null, errorDetails: null }),
    ).toThrow(WebArenaError);
    expect(() =>
      validateAgentResponse({ taskType: "MUTATE", status: "SUCCESS", retrievedDataRaw: '["x"]', errorDetails: null }),
    ).toThrow(WebArenaError);
    expect(() =>
      validateAgentResponse({ taskType: "NAVIGATE", status: "SUCCESS", retrievedDataRaw: null, errorDetails: "bad" }),
    ).toThrow(WebArenaError);
    expect(() =>
      validateAgentResponse({ taskType: "BAD", status: "SUCCESS", retrievedDataRaw: null, errorDetails: null }),
    ).toThrow(WebArenaError);
    expect(defaultConfig().trace_file_name).toBe("network.har");
  });

  test("lists public tasks with site, template, pending, and limit filters while stripping eval/expected", () => {
    const config = defaultConfig();
    const datasetPath = join(workDir, "dataset-list.json");
    const outDir = join(workDir, "out-list");
    mkdirSync(join(outDir, "10"), { recursive: true });
    writeFileSync(
      join(outDir, "10", "agent_response.json"),
      JSON.stringify({ task_type: "NAVIGATE", status: "SUCCESS" }),
    );
    writeFileSync(
      datasetPath,
      JSON.stringify([
        {
          task_id: 20,
          sites: ["gitlab"],
          start_urls: ["__GITLAB__/a"],
          intent: "Second of tpl 1",
          intent_template_id: 1,
          eval: [{ expected: "SECRET_20" }],
        },
        {
          task_id: 10,
          sites: ["gitlab"],
          start_urls: ["__GITLAB__/a"],
          intent: "First of tpl 1",
          intent_template_id: 1,
          eval: [{ expected: "SECRET_10" }],
        },
        {
          task_id: 30,
          sites: ["gitlab"],
          start_urls: ["__GITLAB__/b"],
          intent: "Only of tpl 2",
          intent_template_id: 2,
          eval: [{ expected: "SECRET_30" }],
        },
        {
          task_id: 40,
          sites: ["gitlab", "reddit"],
          start_urls: ["__GITLAB__", "__REDDIT__"],
          intent: "Multi-site task",
          intent_template_id: 3,
          eval: [{ expected: "SECRET_40" }],
        },
        {
          task_id: 50,
          sites: ["reddit"],
          start_urls: ["__REDDIT__"],
          intent: "Reddit task",
          intent_template_id: 4,
          eval: [{ expected: "SECRET_50" }],
        },
      ]),
    );

    const gitlabOnly = listTasksPublic(datasetPath, config, { sites: ["gitlab"] });
    expect(gitlabOnly.totalInDataset).toBe(5);
    expect(gitlabOnly.tasks.map((t) => t.task_id)).toEqual([10, 20, 30]);
    expect(JSON.stringify(gitlabOnly)).not.toContain("SECRET_");

    const onePerTpl = listTasksPublic(datasetPath, config, { sites: ["gitlab"], onePerTemplate: true });
    expect(onePerTpl.tasks.map((t) => t.task_id)).toEqual([10, 30]);

    const pending = listTasksPublic(datasetPath, config, {
      sites: ["gitlab"],
      onePerTemplate: true,
      pendingOutDir: outDir,
    });
    expect(pending.tasks.map((t) => t.task_id)).toEqual([30]);

    const multi = listTasksPublic(datasetPath, config, { sites: ["gitlab", "reddit"], limit: 2 });
    expect(multi.tasks.map((t) => t.task_id)).toEqual([10, 20]);
  });

  test("inspectSiteConfigs never exposes credentials and flags invalid auth config", () => {
    const configPath = join(workDir, "config-inspect.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        environments: {
          shopping_admin: {
            urls: ["http://127.0.0.1:7780/admin"],
            use_header_login: true,
            credentials: { username: "admin", password: "SuperSecretPassword!" },
          },
          gitlab: {
            urls: ["http://127.0.0.1:8023"],
            use_header_login: false,
            credentials: { username: "byteblaze", password: "GitLabSecretPassword!" },
          },
          reddit: {
            urls: ["http://127.0.0.1:9999"],
            use_header_login: true,
            credentials: { username: "u", password: "RedditSecretPassword!" },
          },
          wikipedia: {
            urls: ["http://127.0.0.1:8888"],
            use_header_login: false,
          },
        },
      }),
    );
    const { config } = loadConfig(configPath);
    const summaries = inspectSiteConfigs(config, ["shopping_admin", "gitlab", "reddit", "wikipedia"]);
    expect(summaries).toEqual([
      { site: "shopping_admin", url: "http://127.0.0.1:7780/admin", auth_mode: "header" },
      { site: "gitlab", url: "http://127.0.0.1:8023", auth_mode: "form" },
      expect.objectContaining({ site: "reddit", url: "http://127.0.0.1:9999", auth_mode: "invalid" }),
      { site: "wikipedia", url: "http://127.0.0.1:8888", auth_mode: "none" },
    ]);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain("SuperSecretPassword!");
    expect(serialized).not.toContain("GitLabSecretPassword!");
    expect(serialized).not.toContain("RedditSecretPassword!");
    expect(serialized).not.toContain("byteblaze");
  });

  test("summarizeRunDir includes failed, blocked, and incomplete runs without leaking eval_result details", () => {
    const outDir = join(workDir, "run-summary");
    mkdirSync(join(outDir, "10"), { recursive: true });
    mkdirSync(join(outDir, "20"), { recursive: true });
    mkdirSync(join(outDir, "30"), { recursive: true });

    // Task 10: done + evaluated success
    writeFileSync(
      join(outDir, "10", "webhand.jsonl"),
      `${JSON.stringify({ type: "run_end", status: "done", attempts: 1 })}\n`,
    );
    writeFileSync(join(outDir, "10", "network.har"), "{}");
    writeFileSync(
      join(outDir, "10", "agent_response.json"),
      JSON.stringify({ task_type: "RETRIEVE", status: "SUCCESS" }),
    );
    writeFileSync(
      join(outDir, "10", "eval_result.json"),
      JSON.stringify({
        task_id: 10,
        status: "success",
        score: 1,
        expected: ["TOP_SECRET_ANSWER"],
        assertions: ["HIDDEN"],
      }),
    );

    // Task 20: blocked + evaluated failure
    writeFileSync(
      join(outDir, "20", "webhand.jsonl"),
      `${JSON.stringify({ type: "run_end", status: "blocked", attempts: 2 })}\n`,
    );
    writeFileSync(
      join(outDir, "20", "agent_response.json"),
      JSON.stringify({ task_type: "MUTATE", status: "UNKNOWN_ERROR", error_details: "Blocked by Monaco" }),
    );
    writeFileSync(
      join(outDir, "20", "eval_result.json"),
      JSON.stringify({ task_id: 20, status: "failure", score: 0, reason: "SHOULD_NOT_LEAK" }),
    );

    // Task 30: incomplete (no run_end, no eval)
    writeFileSync(join(outDir, "30", "network.har"), "{}");

    const report = summarizeRunDir(outDir, defaultConfig());
    expect(report.total).toBe(3);
    expect(report.evaluated).toBe(2);
    expect(report.unevaluated).toBe(1);
    expect(report.success).toBe(1);
    expect(report.failure).toBe(1);
    expect(report.error).toBe(0);
    expect(report.by_task_type.RETRIEVE).toEqual({ total: 1, evaluated: 1, success: 1, failure: 0, error: 0 });
    expect(report.by_task_type.MUTATE).toEqual({ total: 1, evaluated: 1, success: 0, failure: 1, error: 0 });
    expect(report.by_task_type.UNKNOWN).toEqual({ total: 1, evaluated: 0, success: 0, failure: 0, error: 0 });
    expect(
      report.tasks.map((t) => ({ id: t.task_id, status: t.status, attempts: t.attempts, score: t.score })),
    ).toEqual([
      { id: 10, status: "done", attempts: 1, score: 1 },
      { id: 20, status: "blocked", attempts: 2, score: 0 },
      { id: 30, status: "incomplete", attempts: null, score: null },
    ]);

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("TOP_SECRET_ANSWER");
    expect(serialized).not.toContain("SHOULD_NOT_LEAK");
    expect(serialized).not.toContain("HIDDEN");
  });
});

describe("research/webarena html report", () => {
  beforeEach(() => {
    workDir = tmpPath();
  });

  test("links each task's files and screenshots, escapes the logs, and shows only the eval score", async () => {
    const task = join(workDir, "7");
    mkdirSync(join(task, "webhand-screenshots"), { recursive: true });
    writeFileSync(join(task, "webhand-screenshots", "step-0001-attempt-1.png"), "png");
    const events = [
      { type: "run_start", goal: "Find <b>it</b>" },
      { type: "plan", attempt: 1, steps: ["1. Open the list"] },
      { type: "step", step: 1, attempt: 1, operation: "CLICK", action: "<script>x</script>" },
      { type: "screenshot", step: 1, attempt: 1, after: "action", file: "../../elsewhere/step-0001-attempt-1.png" },
      { type: "step", step: 2, attempt: 1, operation: "CLICK", action: "Save" },
      { type: "run_end", status: "done", attempts: 1, reason: "shown" },
    ];
    writeFileSync(join(task, "webhand.jsonl"), events.map((x) => JSON.stringify(x)).join("\n"));
    writeFileSync(join(task, "eval_result.json"), JSON.stringify({ score: 0, status: "failure", expected: "SECRET" }));
    const config = join(workDir, "config.json");
    writeFileSync(config, "{}");

    const made = await wa("html", "--output-dir", workDir, "--config", config);
    expect(made.out).toContain(join(workDir, "index.html"));
    const read = (name: string) => readFileSync(join(workDir, name), "utf8");
    expect(read("index.html")).toContain('href="7/7.html"');
    expect(read("index.html")).toContain('href="7/eval_result.json"');
    expect(read("index.html")).toContain("判定なし");
    const plain = read("7/7.html");
    expect(plain).toContain("&lt;script&gt;x&lt;/script&gt;");
    // The page's own slider script is the only one: nothing from the log became markup.
    expect(plain).not.toContain("<script>x");
    expect(plain.match(/<script>/g)).toHaveLength(1);
    expect(plain).toContain('src="webhand-screenshots/step-0001-attempt-1.png"');
    expect(plain).not.toContain("elsewhere");
    expect(`${plain}${read("index.html")}`).not.toContain("SECRET");
    expect(plain).toContain('href="eval_result.json"');
    expect(plain.match(/="\.\.\/[^"]*"/g)).toEqual(['="../index.html"']);

    writeFileSync(join(workDir, "notes.json"), JSON.stringify({ 7: { ok_until: 1, summary: "Save <failed>" } }));
    await wa("html", "--out-dir", workDir, "--config", config);
    expect(read("7/7.html")).toContain('<section class="slide" id="s1"><div class="step ok">');
    expect(read("7/7.html")).toContain('<section class="slide" id="s2"><div class="step problem">');
    expect(read("7/7.html")).toContain('<a class="problem" href="#s2" title="Save">2</a>');
    expect(read("index.html")).toContain("Save &lt;failed&gt;");

    const plan = [{ attempt: 1, item: 1, state: "met", step: 1, evidence: "<list>" }];
    writeFileSync(join(workDir, "notes.json"), JSON.stringify({ 7: { summary: "ok", plan } }));
    await wa("html", "--output-dir", workDir, "--config", config);
    const checked = read("7/7.html");
    expect(checked).toContain(
      '<td class="met">達成</td><td class="strip"><a href="#s1">1</a></td><td>&lt;list&gt;</td>',
    );
    expect(checked).toContain('<span class="met">計画 1 達成</span>');

    const wrong = [{ attempt: 1, item: 1, state: "done" }];
    writeFileSync(join(workDir, "notes.json"), JSON.stringify({ 7: { summary: "ok", plan: wrong } }));
    expect(await waExit("html", "--output-dir", workDir, "--config", config)).toContain('needs "plan"');

    writeFileSync(join(workDir, "notes.json"), JSON.stringify({ 7: {} }));
    expect(await waExit("html", "--output-dir", workDir, "--config", config)).toContain('needs a "summary"');
  });
});

describe("research/webarena CLI integration", () => {
  let cleanup: () => Promise<void>;
  let server: Server;
  let baseUrl: string;
  let seenAuthPaths: string[];

  beforeEach(async () => {
    ({ cleanup } = isolate());
    workDir = tmpPath();
    seenAuthPaths = [];
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      const autoLogin = req.headers["x-m2-admin-auto-login"];
      const cookies = req.headers.cookie ?? "";
      if (url === "/customer/account/login" && req.method === "GET") {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            '<!doctype html><title>Customer Login</title><form id="login-form" method="post" action="/customer/account/loginPost/">' +
              '<input id="email" name="login[username]" type="email">' +
              '<input id="pass" name="login[password]" type="password">' +
              '<button id="send2" type="submit">Sign In</button></form>',
          );
        return;
      }
      if (url === "/customer/account/loginPost/" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += String(chunk);
        });
        req.on("end", () => {
          const params = new URLSearchParams(body);
          if (params.get("login[username]") === "emma@example.com" && params.get("login[password]") === "ShopPass!99") {
            seenAuthPaths.push(url);
            res
              .writeHead(302, {
                location: "/customer/account/",
                "set-cookie": "shop_sid=emma_cookie; Path=/; HttpOnly",
              })
              .end();
          } else {
            res.writeHead(302, { location: "/customer/account/login" }).end();
          }
        });
        return;
      }
      if (url === "/customer/account/") {
        if (!cookies.includes("shop_sid=emma_cookie")) {
          res.writeHead(302, { location: "/customer/account/login" }).end();
          return;
        }
        res
          .writeHead(200, { "content-type": "text/html" })
          .end("<!doctype html><title>My Account</title><p>Welcome, Emma!</p>");
        return;
      }
      if (autoLogin === "admin:admin1234") {
        if (url !== "/favicon.ico") seenAuthPaths.push(url);
        res
          .writeHead(200, {
            "content-type": "text/html",
            "set-cookie": "admin_sid=authed_cookie; Path=/; HttpOnly",
          })
          .end("<!doctype html><title>Bootstrap</title><p>Logged in</p>");
        return;
      }
      if (!cookies.includes("admin_sid=authed_cookie")) {
        res.writeHead(401, { "content-type": "text/html" }).end("<!doctype html><title>Login required</title>");
        return;
      }
      if (url === "/admin" || url === "/admin/") {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            '<!doctype html><title>Admin Dashboard</title><p>Top product: Quest Band</p><a href="/admin/orders">Orders</a>',
          );
        return;
      }
      if (url === "/admin/orders") {
        res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Orders</title><p>Order #1</p>");
        return;
      }
      res.writeHead(404).end("not found");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    const state = session.load();
    if (state?.har) await stopHarRecorder(state.har);
    await cleanup();
    await new Promise((done) => server.close(done));
    rmSync(workDir, { recursive: true, force: true });
  });

  test("pre-authenticates before HAR starts, records network.har without credentials, and writes agent_response.json", async () => {
    const datasetPath = join(workDir, "dataset.json");
    const configPath = join(workDir, "config.json");
    const outDir = join(workDir, "out");
    writeFileSync(
      datasetPath,
      JSON.stringify([
        {
          task_id: 44,
          sites: ["shopping_admin"],
          start_urls: ["__SHOPPING_ADMIN__"],
          intent: "Get top product name",
          eval: [{ evaluator: "AgentResponseEvaluator", expected: { retrieved_data: ["Quest Band"] } }],
        },
      ]),
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        test_data_file: datasetPath,
        environments: {
          shopping_admin: {
            urls: [`${baseUrl}/admin`],
            use_header_login: true,
            credentials: { username: "admin", password: "admin1234" },
          },
        },
      }),
    );

    const info = await wa("info", "--task-id", "44", "--config", configPath);
    expect(info.code).toBe(0);
    expect(info.out).toContain("Get top product name");
    expect(info.out).not.toContain("AgentResponseEvaluator");

    const started = await wa(
      "start",
      "--task-id",
      "44",
      "--config",
      configPath,
      "--out-dir",
      outDir,
      "--chrome",
      "linux",
    );
    expect(started.code).toBe(0);
    expect(started.out).toContain("Admin Dashboard");
    expect(started.out).toContain("AUTO_LOGIN: pre-authenticated shopping_admin");
    expect(seenAuthPaths).toEqual(["/admin"]);

    ScriptedJev.moves = [
      ["CLICK", "Orders", null],
      ["DONE", null, null],
    ];
    expect((await wa("run")).out).toContain("OUTCOME GOAL_REPORTED");

    // Invalid FinalAgentResponse is rejected BEFORE closing the active session.
    const badFinish = await waExit("finish", "--status", "done", "--task-type", "RETRIEVE", "--wa-status", "SUCCESS");
    expect(badFinish).toContain("--retrieved-data");
    expect(session.load()).not.toBeNull();

    const finished = await wa(
      "finish",
      "--status",
      "done",
      "--task-type",
      "RETRIEVE",
      "--wa-status",
      "SUCCESS",
      "--retrieved-data",
      '["Quest Band"]',
      "--reason",
      "Read top product from Admin Dashboard",
    );
    expect(finished.code).toBe(0);
    expect(finished.out).toContain("AGENT_RESPONSE:");

    const harPath = join(outDir, "44", "network.har");
    const responsePath = join(outDir, "44", "agent_response.json");
    expect(existsSync(harPath)).toBe(true);
    expect(existsSync(responsePath)).toBe(true);
    expect(statSync(responsePath).mode & 0o777).toBe(0o600);

    // HAR must contain the authenticated task traffic, and NEVER the Auto-Login header or password.
    const harText = readFileSync(harPath, "utf8");
    expect(harText).not.toContain("x-m2-admin-auto-login");
    expect(harText).not.toContain("X-M2-Admin-Auto-Login");
    expect(harText).not.toContain("admin1234");
    const har = JSON.parse(harText) as HarDocument;
    expect(har.log.entries.some((e) => e.request.url === `${baseUrl}/admin` && e.response.status === 200)).toBe(true);
    expect(har.log.entries.some((e) => e.request.url === `${baseUrl}/admin/orders` && e.response.status === 200)).toBe(
      true,
    );

    expect(JSON.parse(readFileSync(responsePath, "utf8"))).toEqual({
      task_type: "RETRIEVE",
      status: "SUCCESS",
      retrieved_data: ["Quest Band"],
    });
  });

  test("allows finish --status abandoned without FinalAgentResponse and avoids empty dirs when a session is active", async () => {
    const datasetPath = join(workDir, "dataset.json");
    const configPath = join(workDir, "config.json");
    const outDir = join(workDir, "out-abandoned");
    writeFileSync(
      datasetPath,
      JSON.stringify([
        { task_id: 44, sites: ["shopping_admin"], start_urls: ["__SHOPPING_ADMIN__"], intent: "Task 44" },
        { task_id: 45, sites: ["shopping_admin"], start_urls: ["__SHOPPING_ADMIN__"], intent: "Task 45" },
      ]),
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        test_data_file: datasetPath,
        environments: {
          shopping_admin: {
            urls: [`${baseUrl}/admin`],
            use_header_login: true,
            credentials: { username: "admin", password: "admin1234" },
          },
        },
      }),
    );

    const started = await wa(
      "start",
      "--task-id",
      "44",
      "--config",
      configPath,
      "--out-dir",
      outDir,
      "--chrome",
      "linux",
    );
    expect(started.code).toBe(0);

    // Starting another task on the same session id fails without creating an empty task directory.
    const dup = await waExit(
      "start",
      "--task-id",
      "45",
      "--config",
      configPath,
      "--out-dir",
      outDir,
      "--chrome",
      "linux",
    );
    expect(dup).toContain("A session is active");
    expect(existsSync(join(outDir, "45"))).toBe(false);

    // Abandoning closes cleanly without requiring --task-type / --wa-status and skips agent_response.json.
    const abandoned = await wa("finish", "--status", "abandoned");
    expect(abandoned.code).toBe(0);
    expect(session.load()).toBeNull();
    expect(existsSync(join(outDir, "44", "network.har"))).toBe(true);
    expect(existsSync(join(outDir, "44", "agent_response.json"))).toBe(false);
  });

  test("pre-authenticates shopping via local form login before HAR starts without leaking password, and fails fast on bad credentials", async () => {
    const datasetPath = join(workDir, "dataset-shop.json");
    const configPath = join(workDir, "config-shop.json");
    const badConfigPath = join(workDir, "config-shop-bad.json");
    const outDir = join(workDir, "out-shop");
    writeFileSync(
      datasetPath,
      JSON.stringify([
        {
          task_id: 47,
          sites: ["shopping"],
          start_urls: ["__SHOPPING__/customer/account/"],
          intent: "Check My Account",
        },
      ]),
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        test_data_file: datasetPath,
        environments: {
          shopping: {
            urls: [baseUrl],
            use_header_login: false,
            credentials: { email: "emma@example.com", password: "ShopPass!99" },
          },
        },
      }),
    );
    writeFileSync(
      badConfigPath,
      JSON.stringify({
        test_data_file: datasetPath,
        environments: {
          shopping: {
            urls: [baseUrl],
            use_header_login: false,
            credentials: { email: "emma@example.com", password: "wrong" },
          },
        },
      }),
    );

    const bad = await waExit(
      "start",
      "--task-id",
      "47",
      "--config",
      badConfigPath,
      "--out-dir",
      outDir,
      "--chrome",
      "linux",
    );
    expect(bad).toContain("Form pre-login failed for shopping");
    expect(bad).toContain("post=302");
    expect(bad).toContain("final=");
    expect(bad).not.toContain("wrong");
    expect(session.load()).toBeNull();

    const started = await wa(
      "start",
      "--task-id",
      "47",
      "--config",
      configPath,
      "--out-dir",
      outDir,
      "--chrome",
      "linux",
    );
    expect(started.code).toBe(0);
    expect(started.out).toContain("My Account");
    expect(started.out).toContain("AUTO_LOGIN: pre-authenticated shopping (form)");
    expect(seenAuthPaths).toEqual(["/customer/account/loginPost/"]);

    // Non-secret reproducibility metadata is written to outDir/run_meta.json.
    const metaPath = join(outDir, "run_meta.json");
    expect(existsSync(metaPath)).toBe(true);
    const metaText = readFileSync(metaPath, "utf8");
    expect(metaText).not.toContain("ShopPass!99");
    expect(JSON.parse(metaText)).toMatchObject({
      dataset_file: "dataset-shop.json",
      sites: ["shopping"],
    });

    const log = String(session.load()?.log);
    const finished = await wa(
      "finish",
      "--status",
      "done",
      "--task-type",
      "NAVIGATE",
      "--wa-status",
      "UNKNOWN_ERROR",
      "--error-details",
      "The page stayed empty",
      "--reason",
      "Opened My Account",
    );
    expect(finished.code).toBe(0);
    // The reason is logged; the submitted response holds only what the evaluator compares.
    expect(JSON.parse(readFileSync(join(outDir, "47", "agent_response.json"), "utf8"))).toEqual({
      task_type: "NAVIGATE",
      status: "UNKNOWN_ERROR",
    });
    expect(readFileSync(log, "utf8")).toContain('"error_details":"The page stayed empty"');

    const harText = readFileSync(join(outDir, "47", "network.har"), "utf8");
    expect(harText).not.toContain("ShopPass!99");
    expect(harText).not.toContain("loginPost");
    const har = JSON.parse(harText) as HarDocument;
    expect(
      har.log.entries.some((e) => e.request.url === `${baseUrl}/customer/account/` && e.response.status === 200),
    ).toBe(true);
  });

  test("supports list, doctor, and report CLI commands without leaking secrets or expected answers", async () => {
    const datasetPath = join(workDir, "dataset-cli.json");
    const configPath = join(workDir, "config-cli.json");
    const outDir = join(workDir, "out-cli");
    mkdirSync(join(outDir, "101"), { recursive: true });
    writeFileSync(
      join(outDir, "101", "webhand.jsonl"),
      `${JSON.stringify({ type: "run_end", status: "done", attempts: 1 })}\n`,
    );
    writeFileSync(join(outDir, "101", "network.har"), "{}");
    writeFileSync(
      join(outDir, "101", "agent_response.json"),
      JSON.stringify({ task_type: "NAVIGATE", status: "SUCCESS" }),
    );
    writeFileSync(
      join(outDir, "101", "eval_result.json"),
      JSON.stringify({ task_id: 101, status: "success", score: 1, expected: ["DO_NOT_LEAK"] }),
    );
    writeFileSync(
      datasetPath,
      JSON.stringify([
        {
          task_id: 101,
          sites: ["shopping"],
          start_urls: ["__SHOPPING__/customer/account/"],
          intent: "Open account",
          intent_template_id: 1,
          eval: [{ expected: "SECRET_101" }],
        },
        {
          task_id: 102,
          sites: ["shopping"],
          start_urls: ["__SHOPPING__/customer/account/"],
          intent: "Open account 2",
          intent_template_id: 2,
          eval: [{ expected: "SECRET_102" }],
        },
      ]),
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        test_data_file: datasetPath,
        environments: {
          shopping: {
            urls: [baseUrl],
            use_header_login: false,
            credentials: { email: "emma@example.com", password: "TopSecretPassword!" },
          },
          gitlab: {
            urls: ["http://127.0.0.1:1"],
            use_header_login: false,
          },
        },
      }),
    );

    const listed = await wa("list", "--sites", "shopping", "--pending", "--out-dir", outDir, "--config", configPath);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("TASKS: 1 (dataset: 2)");
    expect(listed.out).toContain("TASK_IDS: 102");
    expect(listed.out).not.toContain("SECRET_");

    const listedJson = await wa("list", "--sites", "shopping", "--json", "--config", configPath);
    expect(listedJson.code).toBe(0);
    expect(JSON.parse(listedJson.out)).toHaveLength(2);
    expect(listedJson.out).not.toContain("SECRET_");

    const docOk = await wa("doctor", "--sites", "shopping", "--config", configPath);
    expect(docOk.code).toBe(0);
    expect(docOk.out).toContain("DATASET: OK (2 tasks");
    expect(docOk.out).toContain("SITE shopping:");
    expect(docOk.out).toContain("reach=reachable");
    expect(docOk.out).toContain("auth=form");
    expect(docOk.out).not.toContain("TopSecretPassword!");
    expect(docOk.out).not.toContain("emma@example.com");

    const docFail = await wa("doctor", "--sites", "gitlab", "--timeout-ms", "500", "--config", configPath);
    expect(docFail.code).toBe(1);
    expect(docFail.out).toContain("SITE gitlab:");
    expect(docFail.out).toContain("reach=unreachable");

    const repMd = await wa("report", "--output-dir", outDir, "--config", configPath);
    expect(repMd.code).toBe(0);
    expect(repMd.out).toContain("webarena_verified_score (separate from `tasks/` `verify()`)");
    expect(repMd.out).toContain("**1 / 1** (100.0%)");
    expect(repMd.out).toContain("| 101 | `done` | `NAVIGATE` | `SUCCESS` | 1 | `1` (success) |");
    expect(repMd.out).not.toContain("DO_NOT_LEAK");

    const repJson = await wa("report", "--out-dir", outDir, "--format", "json", "--config", configPath);
    expect(repJson.code).toBe(0);
    expect(JSON.parse(repJson.out)).toMatchObject({ total: 1, evaluated: 1, success: 1, failure: 0 });
    expect(repJson.out).not.toContain("DO_NOT_LEAK");
  });
});
