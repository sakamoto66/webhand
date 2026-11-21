---
name: webhand-plain-research
description: Run the webhand skill from the research repository, with the repository's own CLI, for a request that is not a research task. Research repository only; not part of the plugin. Use as the control of a verify experiment round.
argument-hint: "what you want done"
allowed-tools: Read(skills/webhand/SKILL.md), Bash(node research/webhand.ts:*), AskUserQuestion
---

# webhand plain research run

Read `skills/webhand/SKILL.md` and follow it exactly, with this difference only: run every command from the repository root as `node research/webhand.ts` in place of `webhand` (same arguments). Do not use `npx`.

Do not open or list `tasks/` or any fixture folder: the pages are reached only through the browser.
