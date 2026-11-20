/** Saved logins: the file, the refusals, and a login made on one engine opening a signed-in session. */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as auth from "../src/auth.ts";
import { parse, UsageError } from "../src/cli.ts";
import { shellProbe } from "../src/engines/headless-shell.ts";
import * as session from "../src/session.ts";
import { cli, cliExit } from "./helpers.ts";

const OBSCURA = process.env.WEBHAND_OBSCURA ?? join(homedir(), ".local", "share", "obscura", "obscura");
if (existsSync(OBSCURA)) process.env.WEBHAND_OBSCURA = OBSCURA;
process.env.WEBHAND_OBSCURA_ALLOW_PRIVATE = "1";

const STATE: auth.StorageState = {
  cookies: [
    {
      name: "sid",
      value: "secret-value",
      domain: ".example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ],
  origins: [{ origin: "https://app.example.com", localStorage: [{ name: "token", value: "secret-token" }] }],
};

describe("the login file", () => {
  test("is private to the owner, and what it says about itself holds no values", () => {
    auth.save("work", STATE);
    const file = join(session.home(), "auth", "work.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(session.home(), "auth")).mode & 0o777).toBe(0o700);
    expect(auth.load("work").state).toEqual(STATE);
    const summary = auth.summary(auth.load("work"));
    expect(summary).toBe("1 cookies, 1 localStorage items; app.example.com, example.com");
    expect(summary).not.toContain("secret");
  });

  test("lists, replaces and deletes by name; a name cannot be a path", () => {
    expect(auth.names()).toEqual([]);
    auth.save("b", STATE);
    auth.save("a", STATE);
    auth.save("a", { cookies: [], origins: [] });
    expect(auth.names()).toEqual(["a", "b"]);
    expect(auth.load("a").state.cookies).toEqual([]);
    expect(auth.remove("a")).toBe(true);
    expect(auth.remove("a")).toBe(false);
    expect(() => auth.save("../x", STATE)).toThrow(session.SessionError);
    expect(() => auth.exists("a/b")).toThrow(session.SessionError);
  });
});

describe("--auth", () => {
  const start = ["start", "--goal", "Look", "--url", "http://127.0.0.1:1/"];

  test("is refused with --id, in either spelling and either order, and the message says why", () => {
    for (const extra of [
      ["--auth", "work", "--id", "a"],
      ["--id", "a", "--auth", "work"],
      ["--auth=work", "--id=a"],
      ["--auth", "work", "--id", "default"],
    ]) {
      expect(() => parse([...start, ...extra])).toThrow(UsageError);
      expect(() => parse([...start, ...extra])).toThrow("argument --auth: not allowed with argument --id");
    }
    expect(() => parse([...start, "--auth", "work"])).not.toThrow();
    expect(() => parse([...start, "--id", "a"])).not.toThrow();
  });

  test("is refused with a saved profile, and when the login is not saved", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test");
    expect(await cliExit(...start, "--auth", "work", "--session", "profile:p")).toContain(
      "--auth is for a new session",
    );
    expect(await cliExit(...start, "--auth", "work")).toContain("No saved login work. Saved: (none)");
    auth.save("other", STATE);
    expect(await cliExit(...start, "--auth", "work")).toContain("Saved: other");
    expect(session.load()).toBeNull();
  });

  test("auth save needs a session and a name; list and delete need no session", async () => {
    expect(await cliExit("auth", "save", "work")).toContain("No active session");
    expect(await cliExit("auth", "save")).toContain("auth save needs a NAME");
    expect(await cliExit("auth", "save", "../x")).toContain("Expected a login name");
    expect(await cliExit("auth", "save", "work", "--id", "a")).toContain("No active session");
    expect((await cli("auth", "list")).out).toBe("SAVED LOGINS: (none)\n");
    auth.save("work", STATE);
    expect((await cli("auth", "list")).out).toBe("SAVED LOGINS: work\n");
    expect((await cli("auth", "delete", "work")).out).toBe("DELETED login work\n");
    expect((await cli("auth", "delete", "work")).code).toBe(1);
  });
});

// A site that signs in with a cookie (/cookie) or with localStorage (/ls), both set by /login.
let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function site(): Promise<string> {
  const page = (script: string) => `<!doctype html><meta charset=utf-8><body><p id=o>?</p><script>${script}</script>`;
  server = createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    const html = (body: string, headers: Record<string, string> = {}) =>
      response.writeHead(200, { "content-type": "text/html", ...headers }).end(body);
    const show = (yes: boolean) =>
      `document.getElementById("o").textContent=${JSON.stringify(yes ? "SIGNED-IN" : "ANONYMOUS")}`;
    if (path === "/login") {
      return html(page(`localStorage.setItem("token","t-1");document.getElementById("o").textContent="welcome"`), {
        "set-cookie": "sid=abc; Path=/; HttpOnly",
      });
    }
    if (path === "/cookie") return html(page(show(/sid=abc/.test(request.headers.cookie ?? ""))));
    if (path === "/ls") {
      return html(
        page(`document.getElementById("o").textContent=localStorage.getItem("token")==="t-1"?"SIGNED-IN":"ANONYMOUS"`),
      );
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function installed(engine: string): boolean {
  if (engine === "headless-shell") return Boolean(shellProbe.binary());
  if (engine === "obscura") return existsSync(OBSCURA);
  try {
    execFileSync(engine, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.each(["headless-shell", "obscura", "lightpanda"])(
  "a login saved on Chrome opens a signed-in session on %s",
  (engine) => {
    test.skipIf(!installed(engine))(
      "cookie and localStorage both carry over, and a plain session stays anonymous",
      async () => {
        vi.stubEnv("TYPESAFE_API_KEY", "test");
        const base = await site();
        // Sign in on Chrome (the login page sets both), and save it from that session.
        await cli("start", "--engine", "chrome", "--chrome", "linux", "--goal", "Sign in", "--url", `${base}/login`);
        const saved = (await cli("auth", "save", "work")).out;
        expect(saved).toContain("SAVED login work (1 cookies, 1 localStorage items;");
        expect(saved).not.toContain("abc");
        await cli("finish", "--status", "abandoned", "--reason", "test");

        for (const [path, wanted] of [
          ["/cookie", "SIGNED-IN"],
          ["/ls", "SIGNED-IN"],
        ]) {
          const started = await cli(
            "start",
            "--engine",
            engine,
            "--auth",
            "work",
            "--goal",
            "Look",
            "--url",
            `${base}${path}`,
          );
          expect(started.out).toContain("SIGNED IN with saved login work. Pages opened signed in are sent to Jev");
          expect((await cli("observe")).out).toContain(wanted);
          await cli("finish", "--status", "abandoned", "--reason", "test");
        }
        const plain = await cli("start", "--engine", engine, "--goal", "Look", "--url", `${base}/cookie`);
        expect(plain.out).not.toContain("SIGNED IN");
        expect((await cli("observe")).out).toContain("ANONYMOUS");
        await cli("finish", "--status", "abandoned", "--reason", "test");
      },
      60_000,
    );
  },
);
