"""Runbook loading and its place in the role split. Jev is replaced; no paid API."""

import pytest
from test_cli import ScriptedJev, events, isolated  # noqa: F401

from browser_lab import cli, runbook, session

HUMAN = """
service = "demo"
name = "login"
goal = "Open {section}"
start_url = "{url}"
status = "approved"
sources = ["code:test"]

[params.section]
description = "Section"

[params.url]
description = "Start"

[[steps]]
actor = "human"
instruction = "Log in"
done_when = "The account name is shown"

[[steps]]
instruction = "Open {section}"
hints = ["Use the top menu"]
"""


@pytest.fixture
def book(tmp_path, monkeypatch):
    file = tmp_path / "demo.toml"
    monkeypatch.setattr(runbook, "path", lambda _name: file)
    return file


def values(url="about:blank"):
    return {"section": "Reports", "url": url}


def test_parameters_are_filled_everywhere(book):
    book.write_text(HUMAN)
    loaded = runbook.load("demo", values())
    assert loaded["goal"] == "Open Reports"
    assert loaded["steps"][1]["instruction"] == "Open Reports"
    assert loaded["steps"][0]["actor"] == "human"


def test_a_missing_parameter_is_an_error(book):
    book.write_text(HUMAN)
    with pytest.raises(runbook.RunbookError, match="section"):
        runbook.load("demo", {"url": "about:blank"})


def test_an_unknown_parameter_is_an_error(book):
    book.write_text(HUMAN)
    with pytest.raises(runbook.RunbookError, match="typo"):
        runbook.load("demo", {**values(), "typo": "x"})


def test_a_parameter_value_is_not_expanded_again(book):
    book.write_text(HUMAN)
    assert runbook.load("demo", {"section": "{url}", "url": "u"})["goal"] == "Open {url}"


def test_an_unknown_actor_is_an_error(book):
    book.write_text(HUMAN.replace('actor = "human"', 'actor = "robot"'))
    with pytest.raises(runbook.RunbookError, match="robot"):
        runbook.load("demo", values())


@pytest.mark.parametrize("name", ["../secret", "a/b/c", "", "a b"])
def test_names_stay_inside_the_runbook_folder(name):
    with pytest.raises(runbook.RunbookError):
        runbook.path(name)


HOTEL = ["--param", "city=Lisbon", "--param", "category=Design", "--param", "stay=Casa Flora"]


def test_a_draft_needs_explicit_permission():
    with pytest.raises(SystemExit, match="draft"):
        cli.main(["start", "--task", "hotel_filter", "--runbook", "hotel/filter", *HOTEL])
    assert session.load() is None


def test_claude_adopts_the_runbook_and_jev_gets_only_the_current_notes(tmp_path):
    cli.main(["start", "--task", "hotel_filter", "--runbook", "hotel/filter", "--allow-draft", *HOTEL])
    assert session.load()["plan"] == []  # Starting does not plan; Claude adopts the steps.
    assert cli.main(["plan", "--runbook"]) == cli.OK
    ScriptedJev.moves = [("DONE", None, 0.9), ("DONE", None, 0.9)]
    cli.main(["advance"])
    assert "not applied until Find stays" in ScriptedJev.goals[0]
    assert "places in Lisbon" in ScriptedJev.goals[0]
    cli.main(["advance", "--next"])
    assert "not applied until Find stays" not in ScriptedJev.goals[1]
    log = events(tmp_path)
    assert next(e for e in log if e["type"] == "run_start")["runbook"]["name"] == "hotel/filter"
    assert next(e for e in log if e["type"] == "plan")["source"] == "runbook"


def test_a_plan_from_claude_drops_runbook_notes():
    cli.main(["start", "--task", "hotel_filter", "--runbook", "hotel/filter", "--allow-draft", *HOTEL])
    cli.main(["plan", "--runbook"])
    cli.main(["plan", "Search for Lisbon"])
    ScriptedJev.moves = [("DONE", None, 0.9)]
    cli.main(["advance"])
    assert "Hint:" not in ScriptedJev.goals[0]


def test_plan_needs_steps_or_runbook():
    cli.main(["start", "--task", "hotel_filter"])
    assert cli.main(["plan"]) == cli.FAILED
    assert cli.main(["plan", "--runbook"]) == cli.FAILED


def test_human_steps_need_a_visible_window(book):
    book.write_text(HUMAN)
    with pytest.raises(SystemExit, match="--headed"):
        cli.main(["start", "--runbook", "demo", "--param", "section=A", "--param", "url=about:blank"])
    assert session.load() is None


def test_nothing_acts_during_a_human_step(book, tmp_path, monkeypatch, capsys):
    start_chrome = session.start_chrome
    monkeypatch.setattr(session, "start_chrome", lambda headed: start_chrome(headed=False))
    url = "file://" + str(tmp_path / "page.html")
    (tmp_path / "page.html").write_text("<h1>Home</h1><button>Reports</button>")
    book.write_text(HUMAN)
    cli.main(["start", "--runbook", "demo", "--headed", "--param", "section=Reports", "--param", f"url={url}"])
    cli.main(["plan", "--runbook"])
    capsys.readouterr()

    ScriptedJev.moves = [("CLICK", "Reports", 0.9), ("DONE", None, 0.9)]
    assert cli.main(["advance"]) == cli.OK
    assert "ESCALATION HUMAN_STEP" in capsys.readouterr().out
    assert ScriptedJev.goals == []
    assert cli.main(["act", "CLICK", "1"]) == cli.FAILED
    assert session.load()["history"] == []

    # The person changes the page. Jev must then work from the page as it is now.
    from browser_lab.browser import Browser

    browser = Browser(port=session.load()["port"])
    browser.page.evaluate("document.querySelector('h1').textContent = 'Signed in'")
    browser.close()
    assert cli.main(["advance", "--next"]) == cli.OK
    assert session.load()["history"][0]["action"] == "Reports"
    statuses = [e["status"] for e in events(tmp_path) if e["type"] == "human_step"]
    assert statuses == ["requested", "done"]
