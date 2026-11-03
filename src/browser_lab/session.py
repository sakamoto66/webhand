"""A Chrome that outlives each CLI call, plus the run state that must survive between calls.

Two kinds of profile:
- new: a temporary folder, deleted when the run ends. Nothing is signed in.
- profile:NAME: a saved browser-lab profile. A person signs in once with `profile login`, and later
  runs reuse that sign-in. It is never the person's everyday Chrome profile.

On WSL, Chrome can be the Windows one. It is reachable only with mirrored networking, because
Chrome serves its debugging port on the Windows loopback.
"""

import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

import httpx

STARTUP_SECONDS = 15
PROFILE_NAME = re.compile(r"[\w-]+")
CHROMES = {"auto", "linux", "windows"}
WINDOWS_CHROME = (
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
)


class SessionError(RuntimeError):
    """Chrome cannot be started as asked."""


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


def parse_session(spec: str) -> str | None:
    """'new' gives None; 'profile:NAME' gives NAME."""
    if spec == "new":
        return None
    kind, _, name = spec.partition(":")
    if kind != "profile" or not PROFILE_NAME.fullmatch(name):
        raise SessionError(f"Expected --session new or profile:NAME, got {spec!r}")
    return name


# --- Windows Chrome from WSL ---------------------------------------------------------------


def on_wsl() -> bool:
    return bool(os.environ.get("WSL_INTEROP")) or Path("/proc/sys/fs/binfmt_misc/WSLInterop").exists()


def windows_chrome() -> str | None:
    return next((exe for exe in WINDOWS_CHROME if Path(exe).is_file()), None)


def networking_mode() -> str | None:
    try:
        result = subprocess.run(["wslinfo", "--networking-mode"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() or None


def to_windows(path: Path | str) -> str:
    return subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, check=True).stdout.strip()


def windows_local_app_data() -> Path:
    result = subprocess.run(
        ["cmd.exe", "/c", "echo %LOCALAPPDATA%"], capture_output=True, text=True, cwd="/mnt/c", timeout=10
    )
    folder = result.stdout.strip()
    if result.returncode or not folder or "%" in folder:
        raise SessionError("Could not read %LOCALAPPDATA% from Windows")
    return Path(subprocess.run(["wslpath", "-u", folder], capture_output=True, text=True, check=True).stdout.strip())


def choose_chrome(choice: str) -> tuple[str, str | None]:
    """Returns ('linux' or 'windows', a note for the person when auto fell back)."""
    if choice not in CHROMES:
        raise SessionError(f"Unknown --chrome {choice!r}")
    if choice == "linux":
        return "linux", None
    reason = None
    if not on_wsl():
        reason = "not running on WSL"
    elif not windows_chrome():
        reason = "chrome.exe was not found on Windows"
    elif networking_mode() != "mirrored":
        reason = (
            "WSL networking is not mirrored, so the Windows Chrome debugging port is unreachable. "
            "Add networkingMode=mirrored under [wsl2] in %USERPROFILE%\\.wslconfig and run wsl --shutdown"
        )
    if reason is None:
        return "windows", None
    if choice == "windows":
        raise SessionError(f"Cannot use the Windows Chrome: {reason}")
    return "linux", f"Using the Linux Chrome: {reason}"


def profiles_root(chrome: str) -> Path:
    if chrome == "windows":
        return windows_local_app_data() / "browser-lab" / "profiles"
    return home() / "profiles"


def profile_dir(chrome: str, name: str) -> Path:
    if not PROFILE_NAME.fullmatch(name):
        raise SessionError(f"Invalid profile name: {name!r}")
    return profiles_root(chrome) / name


def list_profiles(chrome: str) -> list[str]:
    root = profiles_root(chrome)
    return sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []


def browser_url(url: str, chrome: str) -> str:
    """A local file under WSL must be addressed through \\\\wsl.localhost for the Windows Chrome."""
    if chrome != "windows" or not url.startswith("file:///"):
        return url
    local, _, query = url[len("file://") :].partition("?")
    unc = to_windows(local).replace("\\", "/")  # //wsl.localhost/Ubuntu/...
    return "file:" + unc + (f"?{query}" if query else "")


# --- Start and stop ------------------------------------------------------------------------


def chrome_args(executable: str, user_data_dir: str, *, headed: bool) -> list[str]:
    args = [
        executable,
        "--remote-debugging-port=0",
        f"--user-data-dir={user_data_dir}",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-crash-restore-bubble",
        "--window-size=1120,867",  # The browser UI takes 87px; the page viewport is 1120x780.
        "about:blank",
    ]
    if not headed:
        args.insert(1, "--headless=new")
    return args


def reachable(port: int) -> bool:
    try:
        return httpx.get(f"http://127.0.0.1:{port}/json/version", timeout=2).is_success
    except httpx.HTTPError:
        return False


def start_chrome(*, headed: bool = False, profile: str | None = None, chrome: str = "linux") -> dict:
    """profile=None makes a new temporary folder. A saved profile is kept when the run ends."""
    if chrome == "windows":
        executable = windows_chrome()
        if not executable:
            raise SessionError("chrome.exe was not found on Windows")
    else:
        executable = shutil.which("google-chrome")
        if not executable:
            raise SessionError("google-chrome was not found")
    if profile:
        folder = profile_dir(chrome, profile)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "DevToolsActivePort").unlink(missing_ok=True)
    elif chrome == "windows":
        temporary = windows_local_app_data() / "browser-lab" / "tmp"
        temporary.mkdir(parents=True, exist_ok=True)
        folder = Path(tempfile.mkdtemp(prefix="browser-lab-", dir=temporary))
    else:
        folder = Path(tempfile.mkdtemp(prefix="browser-lab-"))
    user_data_dir = to_windows(folder) if chrome == "windows" else str(folder)
    process = subprocess.Popen(
        chrome_args(executable, user_data_dir, headed=headed),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        cwd="/mnt/c" if chrome == "windows" else None,
    )
    state = {
        "pid": process.pid,
        "profile": str(folder),
        "saved_profile": profile,
        "chrome": chrome,
        "headed": headed,
    }
    port_file = folder / "DevToolsActivePort"
    deadline = time.monotonic() + STARTUP_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None and chrome == "linux":
            break
        if port_file.is_file() and port_file.read_text().strip():
            state["port"] = int(port_file.read_text().split()[0])
            if chrome == "linux" or reachable(state["port"]):
                return state
        time.sleep(0.05)
    stop_chrome(state)
    if profile and process.poll() is not None:
        raise SessionError(f"Chrome exited at once. Is profile {profile!r} open in another Chrome window?")
    raise SessionError("Chrome did not open a reachable debugging port")


def close_over_cdp(port: int) -> bool:
    """The only way to close the Windows Chrome: the WSL pid is just the interop proxy."""
    from playwright.sync_api import sync_playwright

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{port}", timeout=5000)
            browser.new_browser_cdp_session().send("Browser.close")
        return True
    except Exception:
        return False


def stop_chrome(state: dict) -> None:
    # A saved profile closes over CDP too, so Chrome writes its cookies before it exits.
    if (state.get("chrome") == "windows" or state.get("saved_profile")) and state.get("port"):
        if close_over_cdp(state["port"]):
            exited(state["pid"], seconds=10)  # Let Chrome finish writing before any signal.
    try:
        os.killpg(state["pid"], signal.SIGTERM)
    except ProcessLookupError:
        pass
    exited(state["pid"], seconds=5 if state.get("chrome") == "windows" else 2)
    if not state.get("saved_profile"):
        shutil.rmtree(state["profile"], ignore_errors=True)


def exited(pid: int, *, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                return True
        except ChildProcessError:
            pass
        time.sleep(0.05)
    return False


def wait_until_closed(state: dict, until) -> None:
    """For `profile login`: returns when the person closes the window, or until() is true."""
    while not until():
        if state.get("chrome") == "windows":
            if not reachable(state["port"]):
                return
        else:
            try:
                if os.waitpid(state["pid"], os.WNOHANG)[0]:
                    return
            except ChildProcessError:
                return
        time.sleep(0.5)
