---
name: webhand-research
description: Run a research task from tasks/ through webhand, with independent verification by the task's verify(). Research repository only; not part of the plugin. Use when asked to run a webhand research task, such as /webhand-research hotel_filter.
argument-hint: "TASK_NAME..."
allowed-tools: Read(skills/webhand/SKILL.md), Bash(node research/webhand.ts:*), Bash(node research/batch.ts:*), AskUserQuestion
---

# webhand research run

**When the request names more than one task** (several names, a task twice or more, or all tasks), do not run them in this session: get the names with `node research/webhand.ts tasks` if needed, then run `node research/batch.ts --tasks A,B [--repeat N] --model claude-sonnet-5-5 --out DIR` from the repository root as a background command and wait for it. It runs each task in its own new Claude Code session, three at a time (`--parallel N` only when asked) in a new herdr tab with a progress pane. When the user asks for screenshots, prefix the command with `WEBHAND_SCREENSHOTS=1`. `DIR` is a new folder outside the repository or ignored by git (such as `runs/batch/NAME`); it stops on uncommitted or untracked files. Report the `VERIFIED` line, the rows in `DIR/results.jsonl` that were not verified, and `DIR`; if a pane waits on a permission prompt or a question in text, tell the user.

**One task** runs here: read `skills/webhand/SKILL.md` and follow it exactly, with these differences only:

- Run every command from the repository root as `node research/webhand.ts` in place of `webhand` (same arguments). Do not use `npx`.
- Pass `--task NAME` to `start`. The task supplies the GOAL and start URL, so do not pass `--goal` or `--url`. Write the steps and values as the skill says.
- Do not open or list `tasks/`: reading a task's source is refused by design, since `verify()` must stay independent. `start --task NAME` shows the GOAL and opens the start page; plan from that output. To discover available task names (for example, when asked to run all tasks), run `node research/webhand.ts tasks` instead of listing `tasks/`.
- `finish` checks the final page with the task's `verify()`. Report `status`, `verified`, `attempts`, and the log path in one line. `verified` is the result; `status` is only your claim.
