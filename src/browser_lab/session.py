"""A Chrome that outlives each CLI call, plus the run state that must survive between calls."""

import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

STARTUP_SECONDS = 15


def home() -> Path:
    return Path(os.environ.get("BROWSER_LAB_HOME", ".browser-lab"))


def path() -> Path:
    return home() / "session.json"


def load() -> dict | None:
    return json.loads(path().read_text()) if path().is_file() else None


def save(state: dict) -> None:
    home().mkdir(parents=True, exist_ok=True)
    temporary = path().with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        json.dump(state, file, ensure_ascii=False)
    temporary.replace(path())


def clear() -> None:
    path().unlink(missing_ok=True)


def start_chrome(*, headed: bool = False) -> dict:
    """The profile is always a new temporary folder, never a signed-in one."""
    chrome = shutil.which("google-chrome")
    if not chrome:
        raise RuntimeError("google-chrome was not found")
    profile = tempfile.mkdtemp(prefix="browser-lab-")
    args = [
        chrome,
        "--remote-debugging-port=0",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1120,867",  # The browser UI takes 87px; the page viewport is 1120x780.
        "about:blank",
    ]
    if not headed:
        args.insert(1, "--headless=new")
    process = subprocess.Popen(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True
    )
    port_file = Path(profile, "DevToolsActivePort")
    deadline = time.monotonic() + STARTUP_SECONDS
    while time.monotonic() < deadline:
        if port_file.is_file() and port_file.read_text().strip():
            return {"pid": process.pid, "port": int(port_file.read_text().split()[0]), "profile": profile}
        time.sleep(0.05)
    os.killpg(process.pid, signal.SIGTERM)
    shutil.rmtree(profile, ignore_errors=True)
    raise RuntimeError("Chrome did not open a debugging port")


def stop_chrome(state: dict) -> None:
    try:
        os.killpg(state["pid"], signal.SIGTERM)
    except ProcessLookupError:
        pass
    for _ in range(40):
        try:
            os.kill(state["pid"], 0)
        except ProcessLookupError:
            break
        try:
            if os.waitpid(state["pid"], os.WNOHANG)[0]:
                break
        except ChildProcessError:
            pass
        time.sleep(0.05)
    shutil.rmtree(state["profile"], ignore_errors=True)
