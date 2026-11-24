# webhand Documentation

Documentation map for **webhand** — organized by audience so you can jump straight to what you need.

> **Current user documentation** lives in [`README.md`](../README.md), [`usage.md`](usage.md), [`reference.md`](reference.md), and [`examples/runbooks/`](../examples/runbooks/README.md).
> Files under [`design/`](design/) and [`research/`](research/) are architectural design records and historical experiment/evaluation notes (mostly in Japanese); for current capabilities and CLI options, always refer to the user docs and reference.

---

## For users / ユーザー向け

| English | 日本語 | What it covers |
| --- | --- | --- |
| [README](../README.md) | [README.ja.md](../README.ja.md) | 5-minute overview, live demo GIF, 6 skills at a glance, quick start, safety |
| [Usage guide](usage.md) | [利用ガイド](usage.ja.md) | Task-oriented practical workflows: skills, CSV/JSON batch runs, sessions & logins, teaching runbooks, troubleshooting |
| [Reference](reference.md) | [リファレンス](reference.ja.md) | Complete specification: all 18 CLI commands, exit codes (`0–9`), environment variables, TOML schemas (`allowed_domains`, runbooks, checks), engines, logs |
| [Starter runbooks](../examples/runbooks/README.md) | [スターター手順書](../examples/runbooks/README.md) | Copy-and-adapt `service.toml`, `draft` runbooks, and a sample CSV for batch runs |

---

## For contributors / 開発者向け

| English | 日本語 | What it covers |
| --- | --- | --- |
| [DEVELOPMENT.md](../DEVELOPMENT.md) | [DEVELOPMENT.ja.md](../DEVELOPMENT.ja.md) | Contributor setup, modular codebase layout, tests, golden output, release workflow |
| [AGENTS.md](../AGENTS.md) | — | Non-negotiable execution, safety, and experiment rules for coding agents working in this repo |

---

## Design records / 設計記録 (`docs/design/`)

Architectural design documents explaining *why* each subsystem is built the way it is (Japanese):

| Document | Topic |
| --- | --- |
| [design-v2.md](design/design-v2.md) | Flow v2 architecture (whole-page observation, `ESCALATE`/`answer`, site memory) |
| [design-purpose-skills.md](design/design-purpose-skills.md) | Framing of purpose-built skills by output and safety posture |
| [design-check.md](design/design-check.md) | Deterministic acceptance verification (`webhand check` and `/webhand-verify`) |
| [design-regression.md](design/design-regression.md) | Saved check files and regression detection (`/webhand-regress`) |
| [design-extract.md](design/design-extract.md) | Read-only data extraction (`webhand extract` and `/webhand-extract`) |
| [design-explore.md](design/design-explore.md) | Domain-scoped exploratory bug hunting (`--explore` and `/webhand-explore`) |
| [design-shared-browser.md](design/design-shared-browser.md) | Exploratory design note on shared browser vs. per-session contexts |

---

## Research & evaluation notes / 研究・評価記録 (`docs/research/`)

Experiment plans, capability models, benchmark guides, and point-in-time evaluations (Japanese; kept unaltered for research integrity):

| Document | Topic |
| --- | --- |
| [research-plan.md](research/research-plan.md) | Research hypotheses, experiment log, and A/B methodology |
| [capability-model.md](research/capability-model.md) | Capability layers (A–M) and single-variable experiment matrix |
| [webarena-verified.md](research/webarena-verified.md) | Running WebArena-Verified benchmark tasks with HAR recording and offline grading |
| [benchmark-survey.md](research/benchmark-survey.md) | Survey of browser-agent benchmarks and grading reliability |
| [comparison-browser-use.md](research/comparison-browser-use.md) | Point-in-time architectural comparison with `browser-use` |
| [use-case-coverage.md](research/use-case-coverage.md) | Point-in-time evaluation across 25 browser-automation use cases |
