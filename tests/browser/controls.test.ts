/** Real headless Chrome on the local fixtures. No model calls. */

import { afterEach, beforeEach, expect, test } from "vitest";
import { Browser, type ViewChoice } from "../../src/browser/index.ts";
import { ROOT } from "../helpers.ts";
import { find, fixture, task } from "./support.ts";

let browser: Browser;

async function open(url: string, view: ViewChoice | null = null) {
  browser = await Browser.open(url, { view });
  return browser;
}

beforeEach(async () => {
  await open(task.startUrl(ROOT));
});

afterEach(async () => {
  await browser.close();
});

test("a long select dropdown does not evict the form fields and button after it", async () => {
  const url = fixture(
    "long_select.html",
    `<!doctype html><body><main><form>
      <label>Street <input id="street" value="123 Main"></label>
      <label>Country <select id="country"></select></label>
      <label>State <select id="state"></select></label>
      <label>City <input id="city"></label>
      <button type="button" id="save" onclick="document.title='saved'">Save Order Address</button>
    </form></main>
    <div style="margin-top:1600px">
      <label>Offscreen Country <select id="off_country"></select></label>
      <button type="button" id="off_save">Offscreen Save</button>
    </div>
    <script>
      for (const id of ['country', 'off_country']) {
        const s = document.getElementById(id);
        for (let i = 1; i <= 260; i++) s.add(new Option('Country ' + i, 'C' + i));
      }
      const st = document.getElementById('state');
      for (let i = 1; i <= 50; i++) st.add(new Option('State ' + i, 'S' + i));
    </script></body>`,
  );
  await browser.close();
  const page = await (await open(url, { whole: true })).observe();
  const labels = page.actions.map((a: { label: string }) => a.label);
  expect(labels).toContain("City");
  expect(labels).toContain("Save Order Address");
  expect(labels).toContain("State → State 50");
  expect(labels).toContain("Country → Country 260");
  expect(labels).toContain("Offscreen Save");
  expect(page.omitted_actions).toBe(0);
});

test("unlabeled select and textarea do not concatenate their options or value into the accessible name", async () => {
  const url = fixture(
    "unlabeled_fields.html",
    `<!doctype html><body><form>
      <select id="region" title="State/Province">
        <option value="">Please select</option>
        <option value="AL">Alabama</option>
        <option value="NY">New York</option>
      </select>
      <select id="bare">
        <option value="1">One</option>
        <option value="2">Two</option>
      </select>
      <textarea id="notes" placeholder="Order notes">Existing long comment text</textarea>
    </form></body>`,
  );
  await browser.close();
  const page = await (await open(url)).observe();
  const labels = page.actions.map((a: { label: string }) => a.label);
  expect(labels).toContain("State/Province → New York");
  expect(labels).toContain("combobox → Two");
  expect(labels).toContain("Order notes");
  expect(labels.some((l: string) => l.includes("Alabama") && l.includes("New York"))).toBe(false);
  expect(labels.some((l: string) => l.includes("Existing long comment text"))).toBe(false);
});

test("a control covered by its own label or inner span can be clicked, while an unrelated label still blocks", async () => {
  const url = fixture(
    "label_toggle.html",
    `<!doctype html><body>
      <div style="position:relative;width:80px;height:32px">
        <input id="active" type="checkbox" style="width:80px;height:32px;margin:0">
        <label for="active" style="position:absolute;inset:0;display:block;background:#ccc">
          <span style="display:block;width:100%;height:100%">Active</span>
        </label>
      </div>
      <input id="other" type="checkbox">
      <div style="position:relative;width:80px;height:32px;margin-top:20px">
        <input id="blocked" type="checkbox" aria-label="Blocked" style="width:80px;height:32px;margin:0">
        <label for="other" style="position:absolute;inset:0;display:block;background:#fcc">Wrong</label>
      </div>
    </body>`,
  );
  await browser.close();
  const instance = await open(url);
  const page = await instance.observe();
  await instance.act(
    find(page, (a) => a.label === "Active"),
    page,
  );
  expect(await instance.evaluate("document.getElementById('active').checked")).toBe(true);
  const next = await instance.observe();
  await expect(
    instance.act(
      find(next, (a) => a.label === "Blocked"),
      next,
    ),
  ).rejects.toMatchObject({ changed: ["target_covered"] });
});

test("a multi-select can add and deselect options without clearing existing selections", async () => {
  const url = fixture(
    "multi_select.html",
    `<!doctype html><body><form>
      <label>Customer Groups
        <select id="groups" multiple size="4">
          <option value="0" selected>NOT LOGGED IN</option>
          <option value="1">General</option>
          <option value="2">Wholesale</option>
          <option value="3">Retailer</option>
        </select>
      </label>
    </form></body>`,
  );
  await browser.close();
  const instance = await open(url);
  let page = await instance.observe();
  await instance.act(
    find(page, (a) => a.label === "Customer Groups → General"),
    page,
  );
  expect(await instance.fresh(page)).toBe(false);
  expect(await instance.evaluate("[...document.getElementById('groups').selectedOptions].map(o => o.value)")).toEqual([
    "0",
    "1",
  ]);
  page = await instance.observe();
  await instance.act(
    find(page, (a) => a.label === "Customer Groups → Wholesale"),
    page,
  );
  page = await instance.observe();
  await instance.act(
    find(page, (a) => a.label === "Customer Groups → deselect NOT LOGGED IN"),
    page,
  );
  expect(await instance.evaluate("[...document.getElementById('groups').selectedOptions].map(o => o.value)")).toEqual([
    "1",
    "2",
  ]);
});

test("a stacked star-rating radio input covered by earlier labels is clicked via its own label", async () => {
  const url = fixture(
    "star_rating.html",
    `<!doctype html><style>
      .stars { position: relative; height: 28px; width: 150px; }
      .stars input { position: absolute; left: 0; top: 0; width: 16px; height: 16px; margin: 0; }
      .stars label { position: absolute; left: 0; top: 0; height: 28px; display: block; }
      .stars .r1 { width: 28px; z-index: 6; }
      .stars .r2 { width: 56px; z-index: 5; }
      .stars .r3 { width: 84px; z-index: 4; }
      .stars .r4 { width: 112px; z-index: 3; }
      .stars .r5 { width: 140px; z-index: 2; }
    </style><body><div class="stars">
      <input type="radio" name="rating" id="r1" value="1"><label class="r1" for="r1"><span>1 star</span></label>
      <input type="radio" name="rating" id="r2" value="2"><label class="r2" for="r2"><span>2 stars</span></label>
      <input type="radio" name="rating" id="r3" value="3"><label class="r3" for="r3"><span>3 stars</span></label>
      <input type="radio" name="rating" id="r4" value="4"><label class="r4" for="r4"><span>4 stars</span></label>
      <input type="radio" name="rating" id="r5" value="5"><label class="r5" for="r5"><span>5 stars</span></label>
    </div></body>`,
  );
  await browser.close();
  const instance = await open(url);
  for (const [label, id] of [
    ["5 stars", "r5"],
    ["3 stars", "r3"],
    ["1 star", "r1"],
  ] as const) {
    const page = await instance.observe();
    await instance.act(
      find(page, (a) => a.label === label),
      page,
    );
    expect(await instance.evaluate(`document.getElementById('${id}').checked`)).toBe(true);
  }
});

test("opacity:0 and display:none custom checkboxes/radios are observed and clicked via their visible labels", async () => {
  const url = fixture(
    "custom_toggles.html",
    `<!doctype html><style>
      .custom-control { position: relative; padding-left: 24px; margin: 12px 0; }
      .custom-control-input { position: absolute; left: 0; z-index: -1; width: 16px; height: 20px; opacity: 0; }
      .custom-control-label { display: inline-block; cursor: pointer; }
      .hidden-radio { display: none; }
    </style><body>
      <div class="custom-control">
        <input type="checkbox" class="custom-control-input" id="busy">
        <label class="custom-control-label" for="busy">Set yourself as busy</label>
      </div>
      <div>
        <input type="radio" class="hidden-radio" name="vis" id="vis_pub" value="public">
        <label for="vis_pub">Public visibility</label>
      </div>
      <div style="display:none">
        <input type="checkbox" class="custom-control-input" id="ghost">
        <label class="custom-control-label" for="ghost">Hidden panel option</label>
      </div>
      <div style="position:relative;width:160px;height:30px;margin-top:16px">
        <input type="checkbox" class="custom-control-input" id="covered_cb">
        <label class="custom-control-label" for="covered_cb">Covered option</label>
        <div role="dialog" aria-modal="true" style="position:absolute;inset:0;background:#eee">Modal</div>
      </div>
    </body>`,
  );
  await browser.close();
  const instance = await open(url, { whole: true });
  let page = await instance.observe();
  const labels = page.actions.map((a: { label: string }) => a.label);
  expect(labels).toContain("Set yourself as busy");
  expect(labels).toContain("Public visibility");
  expect(labels).not.toContain("Hidden panel option");

  await instance.act(
    find(page, (a) => a.label === "Set yourself as busy"),
    page,
  );
  expect(await instance.evaluate("document.getElementById('busy').checked")).toBe(true);

  page = await instance.observe();
  await instance.act(
    find(page, (a) => a.label === "Public visibility"),
    page,
  );
  expect(await instance.evaluate("document.getElementById('vis_pub').checked")).toBe(true);

  page = await instance.observe();
  await expect(
    instance.act(
      find(page, (a) => a.label === "Covered option"),
      page,
    ),
  ).rejects.toMatchObject({ changed: ["target_covered"] });
});

test("duplicate (role, label) actions receive disambiguating context without reading field values", async () => {
  const url = fixture(
    "duplicate_labels.html",
    `<!doctype html><body>
      <aside>
        <form>
          <div class="block">
            <div class="title"><span>Assignee</span> <a href="#assignee">Edit</a></div>
          </div>
          <div class="block">
            <div class="title"><span>0 Reviewers</span> <a href="#reviewers">Edit</a></div>
          </div>
          <div class="block">
            <div class="title"><span>Labels</span> <a href="#labels">Edit</a></div>
            <input type="password" value="TopSecretPw">
          </div>
          <button type="button">Save</button>
        </form>
      </aside>
    </body>`,
  );
  await browser.close();
  const page = await (await open(url, { whole: true })).observe();
  const edits = page.actions.filter((a: { label: string }) => a.label === "Edit");
  expect(edits.map((a: { context?: string }) => a.context)).toEqual(["Assignee", "0 Reviewers", "Labels"]);
  expect(JSON.stringify(page.actions)).not.toContain("TopSecretPw");
  const save = find(page, (a) => a.label === "Save");
  expect(save.context).toBeUndefined();
});

test("monaco code editor textarea accepts fill via its own view-lines while modals and unrelated covers still block", async () => {
  const url = fixture(
    "monaco_editor.html",
    `<!doctype html><body>
      <div class="monaco-editor" style="position:relative;width:400px;height:120px;border:1px solid #999">
        <textarea id="code_ta" class="inputarea" aria-label="Editor content" style="position:absolute;left:4px;top:4px;width:4px;height:16px">old()</textarea>
        <div id="view_lines" class="view-lines" style="position:absolute;inset:0;background:rgba(255,255,255,0.9)"
          onmousedown="event.preventDefault(); document.getElementById('code_ta').focus()">old()</div>
      </div>
      <div style="position:relative;width:300px;height:80px;margin-top:16px">
        <textarea id="plain_ta" aria-label="Plain notes" style="width:100%;height:100%"></textarea>
        <div style="position:absolute;inset:0;background:rgba(200,0,0,0.4)">Overlay</div>
      </div>
      <div id="covered_editor" class="monaco-editor" style="position:relative;width:300px;height:80px;margin-top:16px">
        <textarea id="blocked_ta" class="inputarea" aria-label="Blocked editor" style="position:absolute;left:4px;top:4px;width:4px;height:16px"></textarea>
        <div class="view-lines" style="position:absolute;inset:0"></div>
        <dialog open style="position:fixed;inset:0;width:100%;height:100%;margin:0;border:0;background:rgba(0,0,0,0.2)">Confirm</dialog>
      </div>
    </body>`,
  );
  await browser.close();
  const instance = await open(url, { whole: true });

  // Remove the full-screen modal first to test normal Monaco fill and plain covered textarea.
  await instance.evaluate("document.querySelector('dialog').remove()");
  let page = await instance.observe();
  await instance.act(
    find(page, (a) => a.kind === "fill" && a.label === "Editor content"),
    page,
    "newCode()",
  );
  expect(await instance.evaluate("document.getElementById('code_ta').value")).toBe("newCode()");

  // Unrelated div covering a normal textarea must still be rejected as target_covered.
  page = await instance.observe();
  await expect(
    instance.act(
      find(page, (a) => a.kind === "fill" && a.label === "Plain notes"),
      page,
      "nope",
    ),
  ).rejects.toMatchObject({ changed: ["target_covered"] });

  // A modal covering a Monaco editor must still be rejected as target_covered.
  await instance.evaluate(
    "const d=document.createElement('dialog'); d.open=true; d.textContent='Modal'; d.style.cssText='position:fixed;inset:0;width:100%;height:100%;margin:0'; document.body.append(d);",
  );
  page = await instance.observe();
  await expect(
    instance.act(
      find(page, (a) => a.kind === "fill" && a.label === "Editor content"),
      page,
      "blocked",
    ),
  ).rejects.toMatchObject({ changed: ["target_covered"] });

  // If clicking a widget surface does not focus its textarea, fail safely before sending keystrokes.
  await instance.evaluate("document.querySelector('dialog').remove()");
  page = await instance.observe();
  await expect(
    instance.act(
      find(page, (a) => a.kind === "fill" && a.label === "Blocked editor"),
      page,
      "shouldNotType",
    ),
  ).rejects.toThrow("Editor did not receive focus after click");
  expect(await instance.evaluate("document.getElementById('blocked_ta').value")).toBe("");
});

test("HOVER opens a hidden sidebar submenu without navigating, letting the next CLICK reach submenu items", async () => {
  const url = fixture(
    "hover_menu.html",
    `<!doctype html><style>
      .sub { display: none; }
      .nav-item.open .sub { display: block; }
    </style><body>
      <header>
        <a href="#content">Skip to content</a>
        <div><a href="#help">Help</a><ul class="sub"><li><a href="#docs">Docs</a></li></ul></div>
      </header>
      <aside>
        <ul>
          <li class="nav-item" onmouseenter="this.classList.add('open')">
            <a href="#repo-tree" onclick="document.title='tree'">Repository</a>
            <ul class="sub">
              <li><a href="#contributors" onclick="document.title='contributors'">Contributors</a></li>
            </ul>
          </li>
          <li><a href="#plain">Plain link</a></li>
        </ul>
      </aside>
    </body>`,
  );
  await browser.close();
  const instance = await open(url, { whole: true });
  let page = await instance.observe();
  expect(
    page.actions.some((a: { kind: string; label: string }) => a.kind === "hover" && a.label === "Repository"),
  ).toBe(true);
  expect(
    page.actions.some((a: { kind: string; label: string }) => a.kind === "hover" && a.label === "Skip to content"),
  ).toBe(false);
  expect(
    page.actions.some((a: { kind: string; label: string }) => a.kind === "hover" && a.label === "Plain link"),
  ).toBe(false);
  expect(page.actions.some((a: { label: string }) => a.label === "Contributors")).toBe(false);

  await instance.act(
    find(page, (a) => a.kind === "hover" && a.label === "Repository"),
    page,
  );
  expect(await instance.evaluate("document.title")).not.toBe("tree");

  page = await instance.observe();
  await instance.act(
    find(page, (a) => a.kind === "click" && a.label === "Contributors"),
    page,
  );
  expect(await instance.evaluate("document.title")).toBe("contributors");
});
