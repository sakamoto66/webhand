# webhand

English | [日本語](README.ja.md)

**A browser agent that learns a service before operating it, the way people get used to a service.** It runs as a Claude Code plugin: ask in plain words for a booking, an application, or a form to fill in, and it operates the browser based on what it has learned.

```text
/webhand On HOTEL PLANISPHERE, book 2 nights for 2 people starting next month's first Saturday
```

- **It learns services.** From a recording of a person using a service, or from the service's source code, it learns the pages, the steps, and the pitfalls, and writes them down as service information and runbooks.
- **It operates from what it learned.** Claude plans the GOAL, steps, and input values from what was learned, and Jev picks each click and entry from the service information and the plan. If the GOAL is not reached, Claude works out why and replans.
- **It works before learning, too.** On a site it has never seen, it plans from your request alone. You can teach it the services you use most, one at a time.

> ⚠️ **The content of the pages webhand operates is sent to Jev (the TypeSafe API)**, including pages you are logged in to when you use a saved profile. See [Safety and privacy](#safety-and-privacy).

## Quick start

1. Add the plugin in Claude Code.

   ```text
   /plugin marketplace add sakamoto66/webhand
   /plugin install webhand@webhand
   ```

2. Set Jev's API key as an environment variable and restart Claude Code. (`TYPESAFE_MODEL` selects the model.)

   ```bash
   echo 'export TYPESAFE_API_KEY=...' >> ~/.bashrc   # or your shell's profile
   ```

3. Ask for something.

   ```text
   /webhand On HOTEL PLANISPHERE, book 2 nights for 2 people starting next month's first Saturday
   ```

Requirements: Node.js 22 or later and Google Chrome (on Linux, or the Windows side from WSL; see [Using Windows Chrome from WSL](docs/reference.md#using-windows-chrome-from-wsl)). The CLI needs no installation: the skills run it with `npx -y webhand@0.4 ...`. For faster startup, install it globally with `npm i -g webhand`; the skills then use `webhand ...`.

```bash
npx -y webhand@0.4 catalog   # smoke check
```

## How it works

```mermaid
flowchart LR
    U([You]) -->|request| P[Claude: plan GOAL, steps, values]
    P --> R[Jev: pick the next action]
    R -->|act| B[(Chrome)]
    B -->|observe| R
    R -->|GOAL reached or needs help| C{Claude: check}
    C -->|done| F([finish])
    C -->|not yet| P
    C -->|missing value, login, CAPTCHA| U
```

1. **Learn**: `/webhand-learn` turns a recorded demonstration, the service's source code, or the log of an earlier run into service information and a runbook.
2. **Ask**: Post a request such as `/webhand book a hotel`. Claude plans the GOAL, steps, and input values from what webhand has learned, and asks you for anything missing.
3. **Choose a session**: A fresh, throwaway session (the default), or a saved profile that keeps you logged in.
4. **Run**: The planned URL opens. Jev picks the next action from the service information, the plan, the current page, and the action history, and loops until the GOAL.
5. **Replan**: If the GOAL is not reached, Claude writes down why, revises the plan, and tries again (up to 3 attempts by default).

To read data without changing anything, use `/webhand-extract`: Jev only reaches the page, and `webhand extract` reads the values from it (a table, a list, links), with the count and what could not be read. The skill keeps it read-only by its own rules (webhand does not enforce it).

To check acceptance criteria instead of getting something done, use `/webhand-verify`: Jev only operates, and Claude judges each check from what the page shows (`PASS`, `FAIL` or `INCONCLUSIVE`, with quoted evidence).

Claude makes the judgment calls (the plan, the values, the check, the replan), and Jev makes the many clicks and entries in between. Jev only chooses among the elements found on the page and the values Claude wrote. Control returns to Claude only when Jev reports the GOAL, needs a value or a person, gets stuck, or cannot tell whether an action took effect. The full list is in [Division of roles](docs/reference.md#division-of-roles).

## Engines

`--engine` chooses what runs the browser. The default, `auto`, uses the headless shell when it is installed and the run needs no window and no saved profile, and Chrome otherwise.

| | Chrome | Headless shell | Obscura | Lightpanda | Browser Run | Kitesurf |
| --- | --- | --- | --- | --- | --- | --- |
| Window (`--headed`), `[person]` steps, `learn`, saved profile | Yes | No | No | No | No | No |
| Memory for one page | about 350–470 MB (`--headless=new`) | about 240–260 MB | about 23–33 MB | about 23–33 MB | None here (runs on Cloudflare) | None here (runs on Cloudflare) |
| Real layout and screenshots | Yes | Yes | Yes | No (simulated) | Yes (Chromium) | Screenshots work; not pixel-perfect (Cloudflare's own browser) |
| Several tabs | Yes | Yes | In practice one (a new window opens nothing or loads in the same tab) | No | Yes | Unreliable: a link that opens a new window can end the session a few seconds later (2 of 3 tries); switching to the new tab worked once |
| Page stays between commands | Yes | Yes | Through a small daemon | Through a small daemon | While the session lives (idle limit 20 min) | Idle limit 60 s |
| Saved login (`--auth`) | Yes | Yes | Yes | Yes | Yes | Yes |

Chrome is the only engine with a window and saved profiles. Obscura and Lightpanda are much lighter but read some pages differently from Chrome, so compare results with Chrome before relying on them. `--engine browser-run` and `--engine kitesurf` are different: the browser runs on Cloudflare ([Browser Run](docs/reference.md#browser-run)), so nothing runs locally, and the pages the run opens are sent to Cloudflare. Kitesurf is Cloudflare's own stateless agent browser (beta, not Chromium) and its session closes after 60 seconds without a command. Details and limits: [Headless shell](docs/reference.md#headless-shell), [Lightpanda](docs/reference.md#lightpanda), [Obscura](docs/reference.md#obscura), [Saved logins](docs/reference.md#saved-logins---auth).

## Safety and privacy

- **What leaves your machine**: The text and actions of the page being operated, and the titles of its other open tabs, go to Jev (the TypeSafe API). With a saved profile, that includes pages you are logged in to. Decide before each run whether that is acceptable.
- **Profiles**: Runs use a temporary profile by default, deleted when the run ends. Login state lives only in profiles dedicated to webhand (`--session profile:NAME`), which you choose per run. webhand never connects to your everyday Chrome profile.
- **Credentials**: You type passwords and codes into Chrome yourself. Claude does not receive them, and webhand does not read the values of password fields.
- **No guessed input**: The only values entered are the ones Claude wrote in the plan and the ones you gave. If something is missing, it asks.
- **No blind retries**: A change to the page is never retried. If webhand cannot tell whether an action took effect, it stops instead of trying again.
- **Page text is untrusted**: Content on the page is treated as data, never as instructions.
- **Recordings and logs**: Learning mode masks password, one-time code, and card fields and all URL query values. Run logs keep the label of each typed value, not the value. Screenshots, saved only with `WEBHAND_SCREENSHOTS=1`, show typed values. Logs and screenshots under `~/.webhand/runs/` still contain page text, so do not share them.
- **What webhand remembers about sites**: The default flow (v2) records the clicks and selects it tried and whether the page changed, per kind of page, in `~/.webhand/knowledge/` on your machine, and offers the ones from runs that ended `done` to Jev on later runs. Typed text, values, personal data, and labels inside list items are not recorded. Turn it off with `WEBHAND_KNOWLEDGE=0` (`WEBHAND_KNOWLEDGE_USE=0` stops only the offering), or delete it with `webhand knowledge clear`.
- **Review before use**: Runbooks start as `draft` and are used for normal runs only after you set them to `approved`. Keep secrets and personal data out of runbooks; pass them as `params`.

## Documentation

| Document | Contents |
| --- | --- |
| [Reference](docs/reference.md) | Where files live, roles and results, sessions, commands, learning mode, page regions, logs |
| [Usage guide](docs/usage.md) | Skills and CLI step by step, common pitfalls |
| [DEVELOPMENT.md](DEVELOPMENT.md) | For contributors: code layout, rules, tests, research, release steps |

## License

MIT License (`LICENSE`).

`assets/snapshot.js`, `src/policies/base.ts`, `src/policies/jev.ts`, and `tasks/fixtures/hotel.html` are modified from [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (MIT). See `THIRD_PARTY_LICENSE_jev-ultrafast.txt`.
