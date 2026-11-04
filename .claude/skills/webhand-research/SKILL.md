---
name: webhand-research
description: Run a research task from tasks/ through webhand, with independent verification by the task's verify(). Research repository only; not part of the plugin. Use when asked to run a webhand research task, such as /webhand-research hotel_filter.
argument-hint: "TASK_NAME"
allowed-tools: Read(skills/webhand/SKILL.md), Bash(node research/webhand.ts:*), AskUserQuestion
---

# webhand research run

Read `skills/webhand/SKILL.md` and follow it exactly, with these differences only:

- Run every command from the repository root as `node research/webhand.ts` in place of `webhand` (same arguments). Do not use `npx`.
- Pass `--task NAME` to `start`. The task supplies the GOAL and start URL, so do not pass `--goal` or `--url`. Write the steps and values as the skill says.
- `finish` checks the final page with the task's `verify()`. Report `status`, `verified`, `attempts`, and the log path in one line. `verified` is the result; `status` is only your claim.
