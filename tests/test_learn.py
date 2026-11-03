"""Recording a demonstration on real Chrome, with trusted input as a person would produce it."""

import json

import pytest

from browser_lab import learn, session
from browser_lab.browser import Browser
from browser_lab.metrics import Recorder

SECRET = "hunter2-do-not-keep"
FORM = """<title>Sign in</title><h1>Sign in</h1>
<form action="next.html"><label>City <input name="city"></label>
<label>Password <input type="password" name="pw"></label>
<label>Reference <input name="ref" autocomplete="one-time-code"></label>
<label><input type="checkbox" name="keep"> Keep me</label>
<select aria-label="Plan" name="plan"><option>Basic</option><option>Pro</option></select>
<button>Continue</button></form>"""


@pytest.fixture
def demo(tmp_path):
    (tmp_path / "form.html").write_text(FORM)
    (tmp_path / "next.html").write_text("<title>Done</title><h1>Welcome</h1><a href='form.html'>Back</a>")
    chrome = session.start_chrome()
    browser = Browser(port=chrome["port"])
    log = tmp_path / "learn.jsonl"
    recorder = Recorder(log)

    def play(moves):
        queue = list(moves)

        def until():
            if queue:
                queue.pop(0)(browser.page)
                browser.page.wait_for_timeout(50)
                return False
            browser.page.wait_for_timeout(600)
            return True

        return learn.record(browser, (tmp_path / "form.html").as_uri(), recorder, until)

    yield play, log
    recorder.close()
    browser.close()
    session.stop_chrome(chrome)


def fill_form(page):
    page.get_by_label("City").click()
    page.keyboard.type("Lisbon")
    page.get_by_label("Password").click()
    page.keyboard.type(SECRET)
    page.get_by_label("Reference").click()
    page.keyboard.type(SECRET)
    page.get_by_label("Keep me").click()


def choose_plan(page):
    page.get_by_label("Plan").focus()  # select_option() fires untrusted events, unlike a person.
    page.keyboard.press("ArrowDown")


MOVES = [fill_form, choose_plan, lambda p: p.get_by_role("button").click()]


def actions(log):
    events = [json.loads(line) for line in log.read_text().splitlines()]
    return [e for e in events if e["type"] == "action"], events


def test_actions_use_the_names_the_agent_sees(demo):
    play, log = demo
    play(MOVES)
    steps, _ = actions(log)
    seen = [(s["operation"], s["label"]) for s in steps]
    assert ("fill", "City") in seen
    assert ("toggle", "Keep me") in seen
    assert ("select", "Plan") in seen
    assert ("click", "Continue") in seen
    assert next(s for s in steps if s["label"] == "City")["value"] == "Lisbon"


def test_secrets_never_reach_the_record(demo):
    play, log = demo
    play(MOVES)
    assert SECRET not in log.read_text()
    steps, _ = actions(log)
    assert [s["value"] for s in steps if s["label"] in ("Password", "Reference")] == ["<redacted>", "<redacted>"]


def test_secrets_in_a_get_form_url_are_masked(demo):
    play, log = demo
    play(MOVES)
    _, events = actions(log)
    pages = [e for e in events if e["type"] == "page" and e["title"] == "Done"]
    assert pages, "recording continues after navigation"
    assert "pw=%3Credacted%3E" in pages[0]["url"]


def test_forged_events_are_ignored(demo):
    play, log = demo
    play([lambda p: p.evaluate("document.querySelector('button').click()")])
    steps, _ = actions(log)
    assert not any(s.get("label") == "Continue" for s in steps)


SHADOW = """<title>Shadow</title><div id="host"></div><script>
const root=document.getElementById('host').attachShadow({mode:'open'});
root.innerHTML='<form action="next.html"><label>City <input name="city"></label>'+
  '<label><input type="checkbox" name="keep"> Keep me</label><button>Continue</button></form>';
</script>"""


def test_changes_inside_open_shadow_dom_are_recorded(demo, tmp_path):
    play, log = demo
    (tmp_path / "form.html").write_text(SHADOW)

    def fill(page):
        page.get_by_label("City").click()
        page.keyboard.type("Lisbon")
        page.get_by_label("Keep me").click()

    play([fill, lambda p: p.get_by_role("button").click()])
    steps, _ = actions(log)
    seen = [(s["operation"], s["label"], s.get("value")) for s in steps]
    assert ("fill", "City", "Lisbon") in seen
    assert ("toggle", "Keep me", None) in seen
    assert any(s["operation"] == "submit" for s in steps)
