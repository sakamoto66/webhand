---
name: webhand-explore-research
description: Run the webhand-explore skill from the research repository, with the repository's own CLI. Research repository only; not part of the plugin. Use when asked to run an explore experiment round.
argument-hint: "the charter, the URL, and the hosts that may be visited"
allowed-tools: Read(skills/webhand-explore/SKILL.md), Bash(node research/webhand.ts:*), AskUserQuestion
---

# webhand-explore research run

Read `skills/webhand-explore/SKILL.md` and follow it exactly, with this difference only: run every command from the repository root as `node research/webhand.ts` in place of `webhand` (same arguments). Do not use `npx`. Read no other skill file.

Do not open or list `tasks/` or any fixture folder: the pages under test are reached only through the browser.
