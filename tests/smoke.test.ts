import { describe, expect, test } from "vitest";
import { skipReason } from "../research/smoke.ts";
import { listTasks, loadTask } from "../research/tasks.ts";
import { UsageError } from "../src/args.ts";
import { inDirectory, ROOT, research, tmpPath } from "./helpers.ts";

describe("research/smoke task discovery", () => {
  test("listTasks returns sorted task names from tasks/", () => {
    const names = listTasks(ROOT);
    expect(names.length).toBeGreaterThan(20);
    expect(names).toEqual([...names].sort());
    expect(names).toContain("hotel_filter");
    expect(names).toContain("cookie_wall");
  });

  test("research tasks lists task names without reading sources", async () => {
    const { code, out } = await research("tasks");
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toEqual(listTasks(ROOT));

    const help = await research("tasks", "--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: node research/webhand.ts tasks");

    await expect(research("tasks", "extra")).rejects.toThrow(UsageError);

    const empty = await inDirectory(tmpPath(), () => research("tasks"));
    expect(empty).toEqual({ code: 0, out: "" });
  });

  test("skipReason separates standalone local tasks from remote, scan, and replan-only tasks", async () => {
    const local = await loadTask("hotel_filter", ROOT);
    expect(skipReason("hotel_filter", local, false, ROOT)).toBeNull();

    const remote = await loadTask("hotel_reserve", ROOT);
    expect(skipReason("hotel_reserve", remote, false, ROOT)).toBe("remote");
    expect(skipReason("hotel_reserve", remote, true, ROOT)).toBeNull();

    const scan = await loadTask("plan_many", ROOT);
    expect(skipReason("plan_many", scan, false, ROOT)).toBe("scan-or-replan");

    const replan = await loadTask("item_moved", ROOT);
    expect(skipReason("item_moved", replan, false, ROOT)).toBe("replan-only");
  });
});
