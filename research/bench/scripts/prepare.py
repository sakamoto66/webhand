"""Prepare one evaluation session: python prepare.py bu2-001

Writes work/<id>/ with the prompt (the task instruction only, never the rubric), an empty outputs/ for
deliverables, a fresh WEBHAND_HOME, and launch.sh. One attempt per task: an existing folder is never reused.
"""

import argparse
import json
import os
import shlex
import subprocess
from datetime import UTC, datetime

from common import CODE, ROUND, WORK, load_task, provenance, write_json

# Mirrors the BrowserCode runner's prompt, minus its browser-tool hints. The skill is invoked the way a
# person would type it.
PROMPT = """/webhand:webhand Save every file deliverable under {outputs}. Those files and your final response are returned to the user. Your final response should be clear and honest.

Task: {task}"""

# From 2026-11-05 (bu2-112 on): the person converses in Japanese. An accepted change of condition.
CLAUDE_MD = """Think in English. Ask the user questions and write your responses to the user in Japanese.
"""

# Set BENCH_SKILL_REPO to a webhand repository to read the skill from it in place (an experiment variable)
# instead of the installed plugin; --plugin-dir replaces an installed plugin of the same name. Used for seed
# 20261106.
SKILL_REPO = os.environ.get("BENCH_SKILL_REPO", "")

# From 2026-11-09 (round aa2 on): the Claude model is fixed here, so a change of Claude Code's default model
# does not change the condition. Rounds more, items, and aa ran on the default, which was Sonnet 5.5 by then.
MODEL = os.environ.get("BENCH_MODEL", "claude-sonnet-5-5")

# From 2026-11-12: webhand's flow (v1 or v2), passed to `webhand start` through WEBHAND_FLOW so that the prompt
# and the skill stay the same across conditions (an experiment variable). Rounds before then ran v1.
# From 2026-11-15: BENCH_CLI_REPO selects which webhand checkout's CLI the session runs (an experiment variable), through
# WEBHAND_CLI_REPO, which the `webhand` command in the PATH reads (a dispatcher; each call is noted in cli_used.log).
# Unset: the globally linked checkout. The skill comes from BENCH_SKILL_REPO, set it to the same repository.
CLI_REPO = os.environ.get("BENCH_CLI_REPO", "")

# From 2026-11-16 (stage 3): what webhand learned about a site in earlier runs. BENCH_KNOWLEDGE_FROM=ROUND copies the
# knowledge folder of the same task in that round into this session's WEBHAND_HOME when it starts (the earlier round
# must have finished by then). BENCH_KNOWLEDGE_USE=0 keeps the hints from Jev (recording goes on).
KNOWLEDGE_FROM = os.environ.get("BENCH_KNOWLEDGE_FROM", "")
KNOWLEDGE_USE = os.environ.get("BENCH_KNOWLEDGE_USE", "1")

# From 2026-11-19: runbooks written by webhand-learn (an experiment variable). BENCH_RUNBOOKS_FROM=DIR copies
# DIR/<task id>/ (service folders with service.toml and runbooks) into this session's WEBHAND_HOME/runbooks, where
# `webhand catalog` lists them for Claude. Only the task's own folder is copied; a missing folder means no runbooks.
RUNBOOKS_FROM = os.environ.get("BENCH_RUNBOOKS_FROM", "")

# From 2026-11-16: BENCH_ENGINE=obscura (etc.) sets WEBHAND_ENGINE for the session (an experiment variable). Obscura's
# executable is not on the PATH, so launch.sh adds its folder.
ENGINE = os.environ.get("BENCH_ENGINE", "")

FLOW = os.environ.get("BENCH_FLOW", "v1")
if FLOW not in ("v1", "v2"):
    raise SystemExit(f"BENCH_FLOW must be v1 or v2, not {FLOW!r}")

# From 2026-11-26: BENCH_PROFILE chooses how much Claude Code loads into the session (an experiment variable). full is
# the condition of every earlier round. lean drops auto memory, most built-in tools, and skills and plugins the task does
# not use (eval-settings-lean.json). skillOverrides matches exact names only, so each synced skill is listed there.
PROFILE = os.environ.get("BENCH_PROFILE", "full")
if PROFILE not in ("full", "lean"):
    raise SystemExit(f"BENCH_PROFILE must be full or lean, not {PROFILE!r}")
SETTINGS = {"full": "eval-settings.json", "lean": "eval-settings-lean.json"}
LEAN_TOOLS = "Bash,Read,Write,Edit,AskUserQuestion,Skill,ToolSearch,WebFetch,WebSearch,Monitor,TaskStop"

LAUNCH = """#!/bin/sh
# One BU Bench evaluation session. Do not guide the agent: see PROTOCOL in the README.
set -eu
cd {work}
{profile_env}export WEBHAND_HOME={home} WEBHAND_SCREENSHOTS=1 WEBHAND_FLOW={flow} WEBHAND_KNOWLEDGE_USE={use}{cli}{engine}
{knowledge}python3 {trust} "$PWD" || true  # A failure only means the trust prompt appears.
date -u +%Y-%m-%dT%H:%M:%SZ > started_at
exec claude --strict-mcp-config {tools}--model {model} {plugin_dir}--settings {settings} "$(cat prompt.txt)"
"""


def skill_commit() -> str:
    """The repository commit the skill is read from; refuses uncommitted changes to the skill."""
    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", SKILL_REPO, *args], check=True, capture_output=True, text=True).stdout.strip()

    if git("status", "--porcelain", "--", "skills", ".claude-plugin"):
        raise SystemExit(f"{SKILL_REPO} has uncommitted changes to the skill; commit them first.")
    return git("rev-parse", "HEAD")


def cli_commit() -> str:
    """The commit of the CLI checkout; it must be built (dist/bin.js) and have no uncommitted source changes."""
    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", CLI_REPO, *args], check=True, capture_output=True, text=True).stdout.strip()

    if not os.path.exists(os.path.join(CLI_REPO, "dist", "bin.js")):
        raise SystemExit(f"{CLI_REPO} has no dist/bin.js; run npm run build there.")
    if git("status", "--porcelain", "--", "src", "assets", "research"):
        raise SystemExit(f"{CLI_REPO} has uncommitted changes to the CLI; commit them first.")
    return git("rev-parse", "HEAD")


def harness_commit() -> str:
    """The commit of this harness; refuses uncommitted changes to it, which would change a round's conditions."""
    def git(*args: str) -> str:
        return subprocess.run(["git", "-C", str(CODE), *args], check=True, capture_output=True, text=True).stdout.strip()

    if git("status", "--porcelain", "--", "."):
        raise SystemExit(f"{CODE} has uncommitted changes to the harness; commit them first.")
    return git("rev-parse", "HEAD")


def eval_settings() -> dict:
    """The profile's settings file with the hooks pointing into this checkout."""
    settings = json.loads((CODE / SETTINGS[PROFILE]).read_text())
    for matchers in settings["hooks"].values():
        for matcher in matchers:
            for hook in matcher["hooks"]:
                hook["command"] = shlex.quote(hook["command"].replace("@CODE@", str(CODE)))
    return settings


def knowledge_copy(work) -> str:
    """Lines for launch.sh: the knowledge of the same task in an earlier round, copied in when the session starts."""
    if not KNOWLEDGE_FROM:
        return ""
    source = work.parent.parent / f"work-{KNOWLEDGE_FROM}" / work.name / "home" / "knowledge"
    return (
        f"if [ -d {shlex.quote(str(source))} ]; then cp -r {shlex.quote(str(source))} {shlex.quote(str(work / 'home'))}/ "
        f"&& echo copied > knowledge_copied; fi\n"
    )


def runbooks_copy(work) -> str:
    """Lines for launch.sh: the runbooks made for this task, copied in when the session starts."""
    if not RUNBOOKS_FROM:
        return ""
    source = os.path.join(RUNBOOKS_FROM, work.name)
    target = work / "home" / "runbooks"
    return (
        f"if [ -d {shlex.quote(source)} ]; then mkdir -p {shlex.quote(str(target))} "
        f"&& cp -r {shlex.quote(source)}/. {shlex.quote(str(target))}/ && echo copied > runbooks_copied; fi\n"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("task_id")
    args = parser.parse_args()
    task = load_task(args.task_id)
    harness = harness_commit()  # Before anything is written: a refused prepare leaves no work folder behind.
    skill = {"skill_repo": SKILL_REPO, "skill_repo_commit": skill_commit()} if SKILL_REPO else {}
    cli = {"cli_repo": CLI_REPO, "cli_repo_commit": cli_commit()} if CLI_REPO else {}
    work = WORK / task["task_id"]
    if work.exists():
        raise SystemExit(f"{work} already exists. Each task gets one attempt; keep it, failed or not.")
    outputs, home = work / "outputs", work / "home"
    outputs.mkdir(parents=True)
    home.mkdir()
    (work / "CLAUDE.md").write_text(CLAUDE_MD)
    (work / "prompt.txt").write_text(PROMPT.format(outputs=outputs, task=task["confirmed_task"]))
    settings = work / "eval-settings.json"
    write_json(settings, eval_settings())
    launch = work / "launch.sh"
    lean = PROFILE == "lean"
    launch.write_text(LAUNCH.format(profile_env="export CLAUDE_CODE_DISABLE_AUTO_MEMORY=1\n" if lean else "", tools=f"--tools {shlex.quote(LEAN_TOOLS)} " if lean else "", work=shlex.quote(str(work)), home=shlex.quote(str(home)), plugin_dir=f"--plugin-dir {shlex.quote(SKILL_REPO)} " if SKILL_REPO else "", model=shlex.quote(MODEL), settings=shlex.quote(str(settings)), trust=shlex.quote(str(CODE / "scripts" / "trust.py")), flow=FLOW, use=KNOWLEDGE_USE, knowledge=knowledge_copy(work) + runbooks_copy(work), cli=f" WEBHAND_CLI_REPO={shlex.quote(CLI_REPO)}" if CLI_REPO else "", engine=f' WEBHAND_ENGINE={shlex.quote(ENGINE)} PATH="$HOME/.local/share/obscura:$PATH"' if ENGINE else ""))
    launch.chmod(0o755)
    write_json(
        work / "meta.json",
        {
            "task_id": task["task_id"],
            "task_sha": task.get("task_sha"),
            "revision": task.get("revision"),
            "prepared_at": datetime.now(UTC).isoformat(),
            "claude_md": CLAUDE_MD,
            "round": ROUND or None,
            "model": MODEL,
            "profile": PROFILE,
            "flow": FLOW,
            "engine": ENGINE or None,
            "knowledge_from": KNOWLEDGE_FROM or None,
            "knowledge_use": KNOWLEDGE_USE,
            "runbooks_from": RUNBOOKS_FROM or None,
            "harness_repo": str(CODE),
            "harness_commit": harness,
            **skill,
            **cli,
            **provenance(),
        },
    )
    print(f"Prepared {task['task_id']}. Run in a new terminal (needs TYPESAFE_API_KEY):\n  {launch}")


if __name__ == "__main__":
    main()
