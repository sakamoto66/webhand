---
name: webhand-regress-research
description: Run the webhand-regress skill from the research repository, with the repository's own CLI. Research repository only; not part of the plugin. Use when asked to run a regression experiment round.
argument-hint: "the saved check name, its parameters and the URL to check"
allowed-tools: Read(skills/webhand-regress/SKILL.md), Bash(node research/webhand.ts:*), AskUserQuestion
---

# webhand-regress research run

Read `skills/webhand-regress/SKILL.md` and follow it exactly, with this difference only: run every command from the repository root as `node research/webhand.ts` in place of `webhand` (same arguments). Do not use `npx`. Read no other skill file.

Do not open or list `tasks/` or any fixture folder: the pages under test are reached only through the browser.
