# Starter Runbooks

Copy-and-adapt templates for teaching webhand how your services work.

Every starter runbook here begins with `status = "draft"` — review it, try it with `--allow-draft`, and change `status = "approved"` once you are happy with it. Never put passwords, tokens, or personal information into runbooks; pass changing values via `params` (or a CSV/JSON batch file) and use `[person]` steps for sign-in.

## Included examples

| Example | What it demonstrates |
| --- | --- |
| [`hotel-planisphere/`](hotel-planisphere/) | Complete example for the public practice site [HOTEL PLANISPHERE](https://hotel-example-site.takeyaqa.dev/ja/): `service.toml` with `allowed_domains`, `reserve.toml` runbook, and `guests.sample.csv` for batch runs |
| [`internal-form/`](internal-form/) | Template for an authenticated internal web form: `allowed_domains`, `[person]` sign-in step, and parameterized form fields |

## How to use

1. Copy an example folder into your project (`.webhand/runbooks/`) or user folder (`~/.webhand/runbooks/`):

   ```bash
   mkdir -p .webhand/runbooks
   cp -r examples/runbooks/hotel-planisphere .webhand/runbooks/
   ```

2. Verify webhand sees it:

   ```bash
   npx -y webhand@0.5 catalog
   ```

3. Trial it once (`--allow-draft`), then set `status = "approved"` in `reserve.toml` after reviewing:

   ```text
   /webhand Reserve on hotel-planisphere with dummy guest details (trial draft)
   ```

4. Optional — run multiple rows from the sample CSV with `webhand batch`:

   ```bash
   npx -y webhand@0.5 batch init --runbook hotel-planisphere/reserve --input examples/runbooks/hotel-planisphere/guests.sample.csv
   ```
