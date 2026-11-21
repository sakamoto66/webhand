---
name: webhand-verify-research
description: Run the webhand-verify skill from the research repository, with the repository's own CLI. Research repository only; not part of the plugin. Use when asked to run a verify experiment round.
argument-hint: "the acceptance criteria and the URL to check"
allowed-tools: Read(skills/webhand-verify/SKILL.md), Bash(node research/webhand.ts:*), AskUserQuestion
---

# webhand-verify research run

Read `skills/webhand-verify/SKILL.md` and follow it exactly, with this difference only: run every command from the repository root as `node research/webhand.ts` in place of `webhand` (same arguments). Do not use `npx`. Read no other skill file.

Do not open or list `tasks/` or any fixture folder: the pages under test are reached only through the browser.
