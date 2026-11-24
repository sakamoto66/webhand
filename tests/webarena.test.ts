import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { run as runWebArena } from "../research/webarena.ts";
import {
  defaultConfig,
  loadConfig,
  loadTaskPublic,
  renderTaskUrl,
  resolveAutoLoginTargets,
  validateAgentResponse,
  WebArenaError,
} from "../research/webarena-config.ts";
import { CliExit } from "../src/commands/context.ts";
import type { HarDocument } from "../src/har.ts";
import { stopHarRecorder } from "../src/har-session.ts";
import * as session from "../src/session.ts";
import { tmpPath } from "./helpers.ts";
import { isolate, ScriptedJev } from "./jev.ts";

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
        site: "shopping_admin",
        url: "http://127.0.0.1:7780/admin",
        header: { name: "X-M2-Admin-Auto-Login", value: "admin:secret" },
      },
      {
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
});
