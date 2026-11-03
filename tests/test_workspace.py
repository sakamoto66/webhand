import os

from webhand import runbook, session, workspace


def test_everything_lives_under_the_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("WEBHAND_HOME", str(tmp_path))
    assert runbook.root() == tmp_path / "runbooks"
    assert session.home() == tmp_path / "state"


def test_env_file_fills_only_unset_variables(tmp_path, monkeypatch):
    monkeypatch.setenv("WEBHAND_HOME", str(tmp_path))
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.setenv("TYPESAFE_MODEL", "kept")
    (tmp_path / ".env").write_text('# comment\nexport TYPESAFE_API_KEY="abc"\nTYPESAFE_MODEL=other\n')
    workspace.load_env()
    assert os.environ["TYPESAFE_API_KEY"] == "abc"
    assert os.environ["TYPESAFE_MODEL"] == "kept"
    monkeypatch.delenv("TYPESAFE_API_KEY")
