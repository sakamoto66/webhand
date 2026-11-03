"""Choosing Chrome and profiles. The Windows Chrome is never started here."""

import pytest

from browser_lab import session


def test_session_spec():
    assert session.parse_session("new") is None
    assert session.parse_session("profile:work") == "work"
    for bad in ("profile:", "profile:../x", "attach:9222", "default"):
        with pytest.raises(session.SessionError):
            session.parse_session(bad)


@pytest.fixture
def wsl(monkeypatch):
    monkeypatch.setattr(session, "on_wsl", lambda: True)
    monkeypatch.setattr(session, "windows_chrome", lambda: "/mnt/c/chrome.exe")


def test_auto_uses_windows_only_when_mirrored(wsl, monkeypatch):
    monkeypatch.setattr(session, "networking_mode", lambda: "mirrored")
    assert session.choose_chrome("auto") == ("windows", None)
    monkeypatch.setattr(session, "networking_mode", lambda: "nat")
    chrome, note = session.choose_chrome("auto")
    assert chrome == "linux" and "mirrored" in note
    with pytest.raises(session.SessionError, match="mirrored"):
        session.choose_chrome("windows")


def test_linux_is_always_linux(wsl):
    assert session.choose_chrome("linux") == ("linux", None)


def test_auto_off_wsl_is_linux(monkeypatch):
    monkeypatch.setattr(session, "on_wsl", lambda: False)
    assert session.choose_chrome("auto")[0] == "linux"


def test_headless_and_profile_arguments():
    args = session.chrome_args("chrome", "C:\\p", headed=False)
    assert args[1] == "--headless=new"
    assert "--user-data-dir=C:\\p" in args and "--remote-debugging-port=0" in args
    assert "--headless=new" not in session.chrome_args("chrome", "p", headed=True)


def test_local_files_go_through_wsl_localhost(monkeypatch):
    monkeypatch.setattr(session, "to_windows", lambda path: "\\\\wsl.localhost\\Ubuntu" + path.replace("/", "\\"))
    url = session.browser_url("file:///home/u/hotel.html?scenario=travel", "windows")
    assert url == "file://wsl.localhost/Ubuntu/home/u/hotel.html?scenario=travel"
    assert session.browser_url("https://example.com/", "windows") == "https://example.com/"
    assert session.browser_url("file:///x.html", "linux") == "file:///x.html"


def test_saved_profiles_live_under_home(tmp_path, monkeypatch):
    monkeypatch.setenv("BROWSER_LAB_HOME", str(tmp_path))
    assert session.list_profiles("linux") == []
    session.profile_dir("linux", "work").mkdir(parents=True)
    assert session.list_profiles("linux") == ["work"]
    with pytest.raises(session.SessionError):
        session.profile_dir("linux", "../escape")
