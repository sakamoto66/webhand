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
    assert runbook.load("demo", {"section": "{url}", "url": "about:blank"})["goal"] == "Open {url}"


def test_an_unknown_actor_is_an_error(book):
    book.write_text(HUMAN.replace('actor = "human"', 'actor = "robot"'))
    with pytest.raises(runbook.RunbookError, match="robot"):
        runbook.load("demo", values())


@pytest.mark.parametrize("name", ["../secret", "a/b/c", "", "a b"])
def test_names_stay_inside_the_runbook_folder(name):
    with pytest.raises(runbook.RunbookError):
        runbook.path(name)


HOTEL = ["--param", "city=Lisbon", "--param", "category=Design", "--param", "stay=Casa Flora"]


def test_a_relative_start_url_is_a_local_file():
    cli.main(["start", "--runbook", "hotel/filter", "--allow-draft", "--chrome", "linux", *HOTEL])
    assert "Forma" in session.load()["page"]["title"]
    assert session.load()["page"]["url"].endswith("tasks/fixtures/hotel.html?scenario=travel")


def test_a_missing_local_start_url_is_an_error():
    with pytest.raises(runbook.RunbookError, match="not found"):
        runbook.resolve_url("tasks/fixtures/missing.html")


def test_a_draft_needs_explicit_permission():
    with pytest.raises(SystemExit, match="draft"):
        cli.main(["start", "--task", "hotel_filter", "--runbook", "hotel/filter", *HOTEL])
    assert session.load() is None


def test_jev_gets_the_runbook_plan_service_facts_and_params_as_values(tmp_path):
    cli.main(
        ["start", "--task", "hotel_filter", "--runbook", "hotel/filter", "--allow-draft", "--chrome", "linux", *HOTEL]
    )
    ScriptedJev.moves = [("DONE", None, None)]
    cli.main(["run"])
    state = ScriptedJev.states[0]
    assert state["plan"]["steps"][0].startswith("1. Enter Lisbon as the Destination")
    assert "places in Lisbon" in state["plan"]["steps"][0]
    facts = state["service"]["facts"]
    assert any("not applied until Find stays" in fact for fact in facts)
    assert {"label": "city", "value": "Lisbon"} in ScriptedJev.plans[0]["values"]
    log = events(tmp_path)
    assert next(e for e in log if e["type"] == "run_start")["runbook"]["name"] == "hotel/filter"
    assert next(e for e in log if e["type"] == "plan")["source"] == "runbook"


def test_steps_from_claude_replace_the_runbook_steps():
    cli.main(
        [
            "start",
            "--task",
            "hotel_filter",
            "--runbook",
            "hotel/filter",
            "--allow-draft",
            "--chrome",
            "linux",
            "--step",
            "Search for Lisbon",
            *HOTEL,
        ]
    )
    assert [s["instruction"] for s in session.load()["plan"]["steps"]] == ["Search for Lisbon"]


def test_human_steps_need_a_visible_window(book):
    book.write_text(HUMAN)
    with pytest.raises(SystemExit, match="--headed"):
        cli.main(["start", "--runbook", "demo", "--param", "section=A", "--param", "url=about:blank"])
    assert session.load() is None


def test_person_steps_are_marked_in_jev_state(book, tmp_path, monkeypatch):
    start_chrome = session.start_chrome
    monkeypatch.setattr(session, "start_chrome", lambda **kw: start_chrome(**{**kw, "headed": False}))
    (tmp_path / "page.html").write_text("<h1>Home</h1><button>Reports</button>")
    url = (tmp_path / "page.html").as_uri()
    book.write_text(HUMAN)
    cli.main(
        [
            "start",
            "--runbook",
            "demo",
            "--headed",
            "--chrome",
            "linux",
            "--param",
            "section=Reports",
            "--param",
            f"url={url}",
        ]
    )
    ScriptedJev.moves = [("NEEDS_HUMAN", None, None)]
    cli.main(["run"])
    assert ScriptedJev.states[0]["plan"]["steps"][0].startswith("1. [person] Log in")


SERVICE = """
service = "demo"
description = "A demo service"
base_url = "https://demo.test/"
sources = ["code:test"]
facts = ["Reports live under the top menu"]

[login]
required = true
url = "https://demo.test/login"
"""


def test_service_information_and_catalog(tmp_path, monkeypatch):
    monkeypatch.setattr(runbook, "ROOT", tmp_path)
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "service.toml").write_text(SERVICE)
    (tmp_path / "demo" / "login.toml").write_text(HUMAN)
    info = runbook.load_service("demo")
    assert info["login"] == {"required": True, "url": "https://demo.test/login"}
    assert info["facts"] == ["Reports live under the top menu"]
    [entry] = runbook.catalog()
    assert [p["name"] for p in entry["procedures"]] == ["demo/login"]
    assert entry["procedures"][0]["human_steps"] == 1
    assert runbook.load_service("missing") is None


def test_service_is_not_a_procedure_name():
    with pytest.raises(runbook.RunbookError):
        runbook.path("hotel/service")


REGION_SERVICE = (
    SERVICE
    + """
[[pages]]
url = "https://demo.test/reports"
purpose = "Reports"

[[pages.regions]]
key = "main/form:Filter"
purpose = "The report filter"

[[pages.regions]]
key = "footer"
purpose = "Site links"
default = "skip"
"""
)


def test_regions_and_their_defaults_are_learned(tmp_path, monkeypatch):
    monkeypatch.setattr(runbook, "ROOT", tmp_path)
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "service.toml").write_text(REGION_SERVICE)
    info = runbook.load_service("demo")
    assert info["pages"][0]["regions"][1] == {"key": "footer", "purpose": "Site links", "default": "skip"}
    assert runbook.service_view(info) == {"focus": [], "skip": ["footer"]}


def test_an_unknown_region_default_is_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(runbook, "ROOT", tmp_path)
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "service.toml").write_text(REGION_SERVICE.replace('"skip"', '"hide"'))
    with pytest.raises(runbook.RunbookError, match="hide"):
        runbook.load_service("demo")


def test_a_runbook_names_regions_to_focus_on_and_skip(book):
    book.write_text('focus = ["form:Filter"]\nskip = ["nav"]\n' + HUMAN)
    loaded = runbook.load("demo", values())
    assert (loaded["focus"], loaded["skip"]) == (["form:Filter"], ["nav"])


def test_region_patterns_must_be_a_list_of_keys(book):
    book.write_text('focus = "form"\n' + HUMAN)
    with pytest.raises(runbook.RunbookError, match="focus"):
        runbook.load("demo", values())


def test_a_later_layer_of_region_choices_wins():
    learned = {"focus": ["main"], "skip": ["footer", "nav"]}
    claude = {"focus": ["nav", "form"], "skip": ["main"]}
    assert runbook.view(learned, None, claude) == {"focus": ["nav", "form"], "skip": ["footer", "main"]}
