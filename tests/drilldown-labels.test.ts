/** `webhand drilldown`: names of checked options and groups when a <label> wraps its input. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OK } from "../src/commands/context.ts";
import { cli, tmpPath } from "./helpers.ts";
import { isolate } from "./jev.ts";

describe("real Chrome CLI: drilldown option labels", () => {
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    ({ cleanup } = isolate());
  });

  afterEach(async () => {
    await cleanup();
  });

  async function drillFields(body: string): Promise<Record<string, string>> {
    const dir = tmpPath();
    writeFileSync(join(dir, "detail.html"), `<title>設定</title><main>${body}</main>`);
    writeFileSync(
      join(dir, "list.html"),
      `<title>一覧</title><main><table><tbody><tr><td>記事</td><td><a href="detail.html">編集</a></td></tr></tbody></table></main>`,
    );
    const url = pathToFileURL(join(dir, "list.html")).href;
    expect((await cli("start", "--goal", "設定を確認する", "--url", url, "--chrome", "linux")).code).toBe(OK);
    const drilled = await cli("drilldown", "--format", "json");
    expect(drilled.code).toBe(OK);
    await cli("finish", "--status", "done");
    return JSON.parse(drilled.out).items[0].fields;
  }

  test("names a checked option by the label that wraps it", async () => {
    const fields = await drillFields(`
      <fieldset><legend>公開設定</legend><label><input type="checkbox" checked> 公開する</label></fieldset>
      <fieldset><legend>公開状態</legend>
        <label><input type="radio" name="state" value="1"> 下書き</label>
        <label><input type="radio" name="state" value="2" checked> 公開中</label>
      </fieldset>
      <fieldset><legend>通知</legend>
        <label for="mail"><input type="checkbox" id="mail" checked> メール</label>
      </fieldset>
      <fieldset><legend>切替</legend>
        <label>固定する <input type="checkbox" id="pin" value="1" checked></label><label for="pin">★</label>
      </fieldset>`);
    expect(fields).toEqual({
      公開設定: "公開する",
      公開状態: "公開中",
      通知: "メール",
      切替: "固定する",
    });
  });

  test("leaves the text of controls inside a wrapping label out of the option name", async () => {
    const fields = await drillFields(`
      <fieldset><legend>期限</legend>
        <label><input type="checkbox" checked> 通知する <select><option>毎日</option></select></label>
      </fieldset>`);
    expect(fields.期限).toBe("通知する");
  });

  test("does not take another option's wrapping label as the group name", async () => {
    const fields = await drillFields(`
      <fieldset><legend>公開状態</legend>
        <div class="field">
          <label><input type="radio" name="state" value="1"> 下書き</label>
          <label><input type="radio" name="state" value="2" checked> 公開中</label>
        </div>
      </fieldset>
      <div class="field">
        <label><input type="checkbox" name="mail"> メール</label>
        <label><input type="checkbox" name="sms" checked> SMS</label>
      </div>`);
    expect(fields).toEqual({ 公開状態: "公開中", sms: "SMS" });
  });

  test("keeps a heading label as the group name of wrapped options", async () => {
    const fields = await drillFields(`
      <div class="field">
        <label>配信方法</label>
        <label><input type="radio" name="via" value="1"> 郵送</label>
        <label><input type="radio" name="via" value="2" checked> 電子</label>
      </div>`);
    expect(fields).toEqual({ 配信方法: "電子" });
  });

  test("does not name an option by a symbol-only wrapping label", async () => {
    const fields = await drillFields(`
      <fieldset><legend>評価</legend>
        <label><input type="radio" id="r1" name="rating" value="1">★</label>
        <label><input type="radio" id="r2" name="rating" value="2" checked>★</label>
      </fieldset>`);
    expect(fields).toEqual({ 評価: "2/2 (r2)" });
  });
});
