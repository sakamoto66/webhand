import pytest


@pytest.fixture(autouse=True)
def workspace(tmp_path, monkeypatch):
    """Tests never read the person's ~/.webhand, including its .env."""
    monkeypatch.setenv("WEBHAND_HOME", str(tmp_path / "workspace"))
