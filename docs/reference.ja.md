# webhand リファレンス

[English](reference.md) | 日本語

[README](../README.ja.md) の詳細です。保存場所、役割分担、セッション、コマンド、使い方を教える（記録と手順書）、ページの領域、ログを説明します。

## 保存場所

ユーザー単位（`~/.webhand/`）とプロジェクト単位（`.webhand/`）の2か所を使います。

| 場所 | パス | 内容 |
| --- | --- | --- |
| ユーザー | `~/.webhand/`（`WEBHAND_HOME` で変更可） | `services/<service>/`（個人用の `service.toml`、手順書 `runbooks/`、保存確認 `checks/`）、`memory/`（flow v2 のサイト記憶。旧 `knowledge/` は自動移行）、`runs/`（実行と実演の JSONL ログ・任意スクリーンショット）、`state/`（実行中セッション、保存プロファイル、`auth/` 保存ログイン、`batches/` バッチ状態） |
| プロジェクト | 現在のディレクトリから上にたどって最初に見つかる `.webhand/`（ホームディレクトリで止まる） | `services/<service>/`（プロジェクトの `service.toml`、手順書 `runbooks/`、保存確認 `checks/`。git で共有できる） |

- 手順書とサービス情報は、プロジェクト、ユーザーの順に探します。同じ名前ならプロジェクトのものを使います。`catalog` は両方を一覧し、それぞれの出所を `(project)` / `(user)` で示します。
- `record` は既定でプロジェクトに書きます（`.webhand/` がなければ git のルート、なければ現在のディレクトリに作ります）。`--scope user` でユーザーに書きます。
- ログイン状態と実行記録はユーザー単位にだけ置き、プロジェクトには置きません。API キーはファイルに置かず、環境変数（`TYPESAFE_API_KEY`）からだけ読みます。

```mermaid
flowchart LR
  AG["コーディングエージェント"] -->|"/webhand-teach"| RB["手順書<br>.webhand/services/#lt;service#gt;/<br>または ~/.webhand/services/#lt;service#gt;/"]
  AG -->|"/webhand<br>計画・入力値・確認・見直し"| CLI["CLI webhand"]
  RB -.->|"catalog"| CLI
  CLI -->|"CDP"| CH["Chrome<br>新規 / 保存プロファイル<br>WSL では Windows 側も可"]
  CLI -->|"run"| JEV["Jev<br>GOAL までの操作を選択"]
```

30日より古い実行フォルダは自動で削除します（`WEBHAND_RUNS_KEEP_DAYS`）。`webhand check-last` や `/webhand-teach` が読むログも対象です。削除するのは `runs/` の下（または1つ下）の、日時の名前のフォルダだけです。新しいログは本人だけが読めます。

## 役割分担

| 担当 | 役割 |
| --- | --- |
| エージェント | GOAL と手順を計画する、入力値を書く、足りない情報を質問する、結果を確認する、計画を見直す、実行を締める |
| Jev | GOAL までの操作ごとに、対象の要素とエージェントの入力値のどれを使うかを番号で選ぶ |
| コード | 選択を観測済み要素とエージェントの値に限定し、鮮度を確認して実行する。独立検証を行う |

`run` は、次のいずれかの場合にだけエージェントに制御を返します。

| 結果 | 発生条件 | エージェントの対応 |
| --- | --- | --- |
| `GOAL_REPORTED` | Jev が GOAL 達成を申告した | ページを GOAL と照合し、`finish` か `replan` |
| `NEEDS_VALUE` | 入力欄に合う値が計画にない | `run --value "ラベル=値"`。わからなければユーザーに聞く |
| `NEEDS_HUMAN` | ログイン、認証コード、CAPTCHA、`[person]` の手順 | ユーザーに依頼し、`run --human-done` |
| `BLOCKED` / `STUCK` / `ATTEMPT_BUDGET` | 進めなくなった | `replan` で再挑戦、`act` で1手補う、または `finish` |
| `ESCALATE` | Jev が判断をエージェントに任せた（flow v2）。目的が求めていない、削除・支払い・送信・取り消せない手順の前、計画にないページで選べる操作がないときなど | `WHY:` を読み、`answer` で同じ試行を続ける |
| `JEV_FAILED` | Jev の応答が使えない（何も実行していない） | もう一度 `run`、`replan`、または `act` |
| `UNCERTAIN` | 操作が実行されたかどうか不明 | 繰り返さず、`finish --status error` |

flow v2 では、ページが変わらないまま `WAIT` が10回続いた場合も、試行は `STUCK` で終わります。

確信度は記録しますが、Jev を止める条件には使いません。

## セッション

| `--session` | 内容 |
| --- | --- |
| `new`（既定） | 一時プロファイル。ログインしていない状態で始まり、終了時に削除されます |
| `profile:NAME` | webhand 専用の保存プロファイル。ログイン状態が次回も残ります |

```bash
webhand profile login work --url https://example.com/login   # 人がログインしてウィンドウを閉じる
webhand profile list
webhand profile delete work
```

普段使いの Chrome プロファイルには接続しません。Chrome 136 以降は、既定のプロファイルへのデバッグ接続ができないためです。保存プロファイルは、Linux では `~/.webhand/state/profiles/`、Windows では `%LOCALAPPDATA%\webhand\profiles\` に置かれます。

### 保存したログイン（`--auth`）

保存したログインは、セッションの Cookie と localStorage を残し、あとの新しいセッションをログイン済みで始められるようにします。保存プロファイルと違い、Chrome に限りません。どのエンジン（Chrome、headless shell、Lightpanda、Obscura）でも、このログインで始められます。

```bash
webhand start --headed --goal ... --url https://example.com/login --step "[person] ログインする"   # 人がログインする
webhand auth save work                       # そのセッションのログインを保存する（--id NAME でセッションを選ぶ）
webhand start --auth work --goal ... --url https://example.com/   # ログイン済みの新しいセッション
webhand auth list
webhand auth delete work
```

- `--auth` は新しいセッション専用です。`--id` や `--session profile:NAME` とは同時に指定できません。
- 保存されるのは、保存したときに開いているタブのサイトだけです（その Cookie と localStorage）。`start` では、開始 URL のサイトの localStorage を戻します。別の origin の localStorage は戻らず、Cookie だけが入ります。その場合は `start` が知らせます。
- ファイルは `~/.webhand/state/auth/NAME.json` で、自分だけが読めます。ログインそのものなので、パスワードと同じに扱い、コミットも貼り付けもしないでください。webhand は中身を表示しません。
- ログイン済みで開いたページは、保存プロファイルと同じく Jev（TypeSafe）に送られます。保存したログインも、ほかのログインと同じく期限が切れます。

### 複数のセッションを同時に使う

セッションごとに、Chrome、プロファイル、計画、履歴が別になります。`start` に `--id NAME`（英数字、`-`、`_`、40文字まで）を付けて名前を決め、そのセッションの以降のコマンド（`run`、`replan`、`act`、`observe`、`finish`）にも同じ `--id` を付けます。`--id` がなければ、これまでどおり `default` です。

```bash
webhand start --id a --goal "..." --url ...
webhand start --id b --goal "..." --url ...    # 2つ目の Chrome。状態は a と別
webhand run --id a
webhand finish --id a --status done
```

- id が `default` でないときは、出力がエージェントに次に実行させるコマンドにも `--id` が付きます。`webhand catalog` は、開いているセッションを目標つきで一覧します。
- 1つのセッションで同時に動くコマンドは1つだけです。2つ目は「Session is busy」で止まります（1つの Chrome で `run` が2つ動くと、二重に操作するため）。コマンドが落ちて残ったロックは引き継ぎます。別の id のコマンドどうしは待ち合いません。
- すでに開いている id では `start` できません。同じ保存プロファイルを2つのセッションで使うことはできず（2つ目の Chrome が終了します）、`profile login` は、開いているセッションが使うプロファイルを断ります。
- 実行記録はセッションごとに別です。状態は `state/session-ID.json`、`state/tab-ID`、`state/session-ID.lock` です（default は `session.json`、`tab`、`session.lock`）。
- 未対応: 複数の人やマシンで共有するセッション、1回の `run` で複数のセッションを動かすこと。

**ログイン後のページの内容は Jev（TypeSafe の API）に送られます。** 個人情報を含む画面を扱うかどうかは、実行前に判断してください。

## WSL で Windows 側の Chrome を使う

`--chrome auto`（既定）は、WSL 上で Windows の `chrome.exe` に接続できればそれを使い、できなければ Linux の Chrome を使います。`--chrome windows` または `--chrome linux` で固定でき、`WEBHAND_CHROME` でも指定できます。

Windows の Chrome は、デバッグポートを Windows の 127.0.0.1 で待ち受けます。そのため、WSL のネットワークを mirrored にする必要があります。

```ini
# %USERPROFILE%\.wslconfig
[wsl2]
networkingMode=mirrored
```

設定したら、PowerShell で `wsl --shutdown` を実行して WSL を再起動します。ローカルファイルの URL は `file://wsl.localhost/...` に変換して開きます。

## ヘッドレスシェル

`--engine headless-shell`（または後述の `auto`）で、Chromium の窓のないビルド `chrome-headless-shell` でセッションを動かします。Chrome と同じエンジンなので（実際のレイアウト、複数タブ、コマンドが終わってもページが残る）、常駐プロセスは要りません。メモリは Chrome の `--headless=new` の約半分です。同じ測定で、1 ページあたり 240〜260 MB 前後に対して、350〜470 MB でした。

- 入れ方: Playwright の `chromium_headless_shell` を、そのブラウザキャッシュ（`~/.cache/ms-playwright`、または `PLAYWRIGHT_BROWSERS_PATH`）から探します。`WEBHAND_HEADLESS_SHELL` にバイナリを指定するか、`chrome-headless-shell` を `PATH` に置いてもかまいません。
- ページは Chrome と同じ 1120x780 です。Chrome の窓には、ブラウザの UI が 87px 含まれます（`--window-size=1120,867`）。シェルには UI がないので `1120,780` で起動します。窓の大きさを同じにすると、別の要素を読んでしまいます。
- 窓も保存プロファイルもありません。`--headed`、`[person]` ステップ、`record`、`profile` は使えず、`--chrome windows` も効きません。Chrome で作ったプロファイルは、シェルのビルドより新しいことがあるためです。
- 窓も保存プロファイルも要らない実行では、これが既定です（`--engine auto`。既定。`WEBHAND_ENGINE` でも指定できます）。窓（`--headed`）、保存プロファイル、`--chrome windows` のときは Chrome のままで、シェルが入っていないときも、黙って Chrome を使います。`--engine chrome` なら必ず Chrome です。どちらで動いたかは `SESSION:` の行に出ます。

## Lightpanda

`--engine lightpanda` で、Chrome の代わりに [Lightpanda](https://lightpanda.io) でセッションを動かします（`--engine` は `auto`、`chrome`、`headless-shell`、`lightpanda`、`obscura`、`browser-run`。既定は `auto`、または `WEBHAND_ENGINE`）。`--chrome auto|linux|windows` は Chrome をどこで動かすかだけを決め、エンジンには効きません。Lightpanda は CDP 接続が終わるとページを失い、webhand はコマンドごとに接続し直します。そこで webhand は小さな常駐プロセス（`src/ipc/daemon.ts`）を起動します。常駐が `lightpanda serve` を動かし、セッションの間、接続とページを1つ保ち、セッション用の一時フォルダにある所有者専用の unix ソケット（`state.socket`）でコマンドに応えます。常駐の中で動くのは同じ `Browser` なので、鮮度確認とリトライしない規則は Chrome と同じです。`finish` で常駐と Lightpanda をまとめて止めます。Chrome のセッションは常駐を使いません。

制約:

- 保存プロファイルはありません（`--session new` のみ）。画面もないため、`--headed`、`[person]` ステップ、`record`、`profile` は使えません。
- `file:` の URL は開けません（ページは http で配信します）。2つ目のタブも開けません。`target="_blank"` のリンクや `window.open` は何も起きず、エラーにもならず、ページはそのままです。そのステップの後に、実行ログへ `window_ignored` イベント（ステップと URL）を残すので、「何も起きなかったクリック」を、拒否されたものと区別できます。Jev に新しい選択肢は出しません。
- レイアウトがないため、要素の位置は模擬で、スクリーンショットはプレースホルダーです。Jev に見せる内容が Chrome と違うので、Chrome との比較は別の実験として扱います。
- `lightpanda` が `PATH` にある必要があります。

## Obscura

`--engine obscura` で、[Obscura](https://github.com/h4ckf0r0day/obscura)（Rust、V8、Apache-2.0）でセッションを動かします。仕組みは Lightpanda と同じで、常駐プロセスが接続とページを保ち、コマンドはセッションのソケットで頼みます。Lightpanda と違い、実際のレイアウト、実際のスクリーンショット、複数ページがあります。

- 入れ方: リリースのアーカイブを展開し（`obscura` と `obscura-worker` を同じ場所に置く）、`WEBHAND_OBSCURA` に `obscura` のパスを設定するか、`PATH` に置きます。
- Obscura は既定で、ループバックとプライベートアドレスを拒否します（SSRF 対策）。ローカルのページを使うときだけ `WEBHAND_OBSCURA_ALLOW_PRIVATE=1` を設定します。実在のサイトでは設定しません。
- 制約は Lightpanda と同じです。保存プロファイルも窓もないので、`--headed`、`[person]` ステップ、`record`、`profile` は使えません。
- 新しいウィンドウ: `window.open` は何も開かず、Lightpanda と同じく `window_ignored` として記録します。`target="_blank"` のリンクは、新しいウィンドウではなく、同じタブでリンク先を読み込みます（ページが変わるので、`window_ignored` は出ません）。
- タブ: Obscura は複数のページを持ち、webhand はそれらを切り替えられます（`TAB_n`）。ただし、ページの操作で2つ目のタブが開くことはない（上記）ので、実際には1つです。`Page.bringToFront` は未実装で、webhand は、それがなくても切り替えます。
- `<body>` の直下にある inline の要素（段落、ブロック、flex の中でないもの）は、大きさが 0 になり、Jev には出ません。ブロックの中にあれば出ます。
- Chrome にある Web API の一部が、Obscura にはありません。webhand は、次のものをページ側に足します（`compat`。`src/browser/scripts/compat.ts`。`assets/snapshot/` はどのエンジンでも同じです）。反復できる `select.selectedOptions`、`isContentEditable`（編集できる div を `textbox` にするため）、フォームの子要素の名前での参照（`form.guest`）、id でのフォームの参照（`document.forms.id`）。後の2つがないと、ハンドラが `form.guest.value` と読むページは例外になり、フォームが送信されません。足せないもの: スタイルシートの規則で指定した cursor は `auto` と読めます（インラインの style だけが `pointer` になる）。CSS の cursor だけでクリックできる要素は、Jev に出ません。

## Browser Run

`--engine browser-run` で、Cloudflare の [Browser Run](https://developers.cloudflare.com/browser-run/)（旧 Browser Rendering）上でセッションを動かします。Cloudflare のネットワーク上のヘッドレス Chrome に CDP で接続します。手元では何も動かず、セッション状態に pid はありません。`start` がセッションを作り（`POST .../browser-run/devtools/browser?keep_alive=1200000`）、各コマンドは Playwright の `connectOverCDP` と `Authorization: Bearer` ヘッダで接続し直し、`finish` が削除します。`auto` では選ばれません。

- 環境変数 `CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN`（権限 "Browser Rendering - Edit"）を設定します。環境変数からだけ読み、セッション状態には保存しません。
- **実行で開いたページは Cloudflare に送られます。** `--auth` を付けると、保存したログインも Browser Run のセッションに注入されます。`start` がそう表示します。実行前にユーザーへ伝えてください。
- 保存プロファイルは使えず（`--session new` のみ）、窓もありません（`--headed`、`[person]` ステップ、`record`、`profile` は拒否）。`--auth` は使えます。
- コマンドが 60 秒来ないとセッションは閉じます。`keep_alive` で延ばせ、webhand は最長の 20 分を求めます。セッションが消えていれば次のコマンドは失敗します（ブラウザへの変更操作はリトライしません）。`start` からやり直してください。
- 上限は Cloudflare のプランによります（Workers Free: 同時 3 ブラウザ、1 日 10 分。Paid: 同時 200）。Chrome との結果の比較はまだしていません。別の実験として扱ってください。
- `--engine kitesurf` は、同じ API で Cloudflare のもう一つのブラウザ Kitesurf を使います。エージェント向けのステートレスなブラウザです（ベータ。アカウントごとの上限の範囲で無料。Chromium ではないので、ページの読み取りが違うことがあります）。上記はすべて当てはまりますが、一つだけ違います。Cloudflare は `keep_alive` との併用を認めないので、コマンドが 60 秒来ないとセッションが閉じます。コマンドの間を空けすぎないか、`browser-run` を使ってください。確認したのは、例のページ、フォーム送信、`--auth`、スクリーンショットです。新しいウィンドウを開くリンク（`target=_blank`）を押すと、約 3 秒後にセッションが終わってコマンドが失敗することがあります（3 回中 2 回。残りの 1 回は新しいタブに切り替わった）。2つ目のタブに頼らないでください。また、作った直後のセッションがすでに閉じている（`410 Gone`）ことが 2 回ありました。Kitesurf はまだベータなので、`start` をやり直す必要があるかもしれません。原因は調べていません。動画、WebGL、ボット対策のチャレンジ、長い、ログイン済みのセッションには向きません（Cloudflare の説明）。

## コマンド

下の表の `webhand` は、インストールしていなければ `npx -y webhand@latest` と読み替えてください。`webhand --version` で版を、`webhand COMMAND --help` で各コマンドの全オプションを確認できます。

| コマンド | 担当 | 内容 |
| --- | --- | --- |
| `webhand catalog [--chrome ...]` | エージェント / 人 | 覚えたサービス情報（`allowed_domains` 含む）、手順書、保存確認、保存プロファイル、実行中セッションを一覧する |
| `webhand doctor [--chrome ...] [--json]` | 人 / エージェント | 読み取り専用の環境診断。Node.js（>= 22）、`TYPESAFE_API_KEY`（値は非表示）、Chrome/WSL、headless shell、ワークスペース状態を確認する |
| `webhand start --goal G --url U --step S ... [--runbook NAME --param K=V \| --batch ID [--row N]] [--service S] [--value L=V ...] [--file L=PATH ...] [--download-dir DIR] [--har PATH] [--read-only] [--explore --allow-domain H --max-total-actions N] --session ...` | エージェント | 計画を記録し、選んだブラウザエンジンで開始 URL を開く |
| `webhand run [--value L=V] [--human-done]` | Jev | GOAL に届くか助けが要るまでページを操作する |
| `webhand answer --note N [--value L=V] [--file L=PATH] [--url URL]` | エージェント | 同じ試行の中で Jev に答える（flow v2 のみ）。履歴と予算を引き継ぎ、`--url` は `allowed_domains` に従う |
| `webhand replan --reason R [--step ...] [--value ...] [--service S] [--focus ...] [--skip ...] [--read ...] [--restart \| --url URL]` | エージェント | 計画を見直して次の試行を始める。`--url` は `allowed_domains` に従う。`--service` は、サービスなしで始めたセッションにサービス情報を加える |
| `webhand act OP [TARGET]` | エージェント | Jev の代わりに操作を 1 つ実行する（`CLICK`, `TYPE_TEXT`, `SELECT`, `UPLOAD_FILE`, `SCROLL_DOWN`, `SCROLL_UP`, `SCROLL_TO`, `WAIT`, `TAB_n`） |
| `webhand observe [--read KIND ...]` | エージェント | 操作せずに現在のページを表示する |
| `webhand check --expect KIND:ARGS ...` | エージェント | 期待を今のページと決定的に照合する（読み取り専用、モデルなし）。`text:`・`no-text:`・`field:`・`checked:`・`count:`・`url:`・`title:`。`--read` はその呼び出しのみ全文を読む |
| `webhand check --saved service/name:ID [--param K=V] [--read] [--production] [--allow-draft]` | エージェント | `.webhand/services/<service>/checks/<name>.toml` に固定した期待で照合し、ログに `check_run` を残す |
| `webhand check-last service/name` | エージェント | 保存確認ごとの最新判定と digest を実行ログから表示する |
| `webhand extract KIND [--within R] [--columns A,B] [--table N] [--rows raw\|data] [--expect-count N] [--format table\|json\|csv\|markdown] [--out PATH]` | エージェント | 決定的な読み取り専用 DOM 抽出（`table`, `list`, `link`, `fields`, `text`）。`--out` はカレントディレクトリ配下へ安全に保存する |
| `webhand findings` | エージェント | `--explore` セッションで記録した異常候補を再現手順つきで表示する |
| `webhand finish --status STATUS [--reason R]` | エージェント | 独立検証（設定時）、バッチ行の結果反映、HAR 書き出し、`run_end` 記録、ブラウザ終了 |
| `webhand record --name NAME --url URL [--scope project\|user] [--session profile:NAME]` | 人 | Chrome で人の実演操作を記録する（旧名 `learn`） |
| `webhand auth save\|list\|delete [NAME]` | エージェント / 人 | `start --auth NAME` で使う保存ログイン（`~/.webhand/state/auth/`）を管理する |
| `webhand batch init\|status\|list\|skip\|clear [NAME]` | エージェント / 人 | 承認済み手順書を CSV / JSON の各行で実行するバッチを管理する（`start --batch ID [--row N]`） |
| `webhand memory list\|show HOST\|clear [HOST]` | 人 | flow v2 が覚えたサイトの記憶（`~/.webhand/memory/`）を表示・消去する（旧名 `knowledge`） |
| `webhand runs list\|prune [--older-than DAYS] [--yes]` | 人 | DAYS より古い実行フォルダを一覧する。`prune --yes` で削除する |
| `webhand profile login\|list\|delete [NAME]` | 人 | webhand 専用の保存 Chrome プロファイルを管理する |

手順の先頭に `[person]` を付けると、人が行う手順になります（`--headed` が必須です）。`start` と `replan` の `--focus REGION` / `--skip REGION` で、観測する領域を選べます（下の「ページの領域」）。`--read KIND` で、画面の外の内容を足せます（下の「画面の外を読む」）。`--runbook NAME --param k=v` を指定すると、手順書の GOAL、開始 URL、手順が既定値になり、params は入力値として Jev に渡されます。

`start` に `--har PATH` を付けると（Chrome または `headless-shell` のみ）、セッションのあいだ CDP サイドカーが通信を記録し、`finish` で Chrome を閉じる直前に HAR 1.2 ファイルを原子的に書き出します（権限 `0600`）。コマンドをまたぐ通信、リダイレクト、新しいタブも記録し、Jev に渡す観測内容は変えません。HAR には Cookie、マスクなしのクエリ文字列、POST 本文、テキスト／JSON のレスポンス本文が含まれるため、機密情報として扱い、コミットや共有をしないでください。

### 終了コード

| コード | 名称 | 意味 |
| --- | --- | --- |
| `0` | `OK` | 正常終了（`doctor` 準備完了、`check` 全 PASS、`extract` COMPLETE、`findings` 0 件） |
| `1` | `FAILED` | エラー、`CliExit`、`doctor` 未達、または `replan` / `answer` 拒否 |
| `2` | `USAGE` | 引数エラー（`UsageError`） |
| `3` | `STALE` | `act` 直前にページが変わり未実行 |
| `4` | `UNCERTAIN` | 変更操作の結果が不明（自動リトライしない） |
| `5` | `BUDGET` | 試行回数または操作数の上限に到達 |
| `6` | `CHECK_FAIL` | `check` に `FAIL` がある、または `extract --expect-count` が不一致（`COUNT_MISMATCH`） |
| `7` | `CHECK_INCONCLUSIVE` | `check` または `extract` が `INCONCLUSIVE` |
| `8` | `EXTRACT_PARTIAL` | `extract` が部分取得（`PARTIAL`：列不足・非表示行・読めない frame/canvas あり） |
| `9` | `FINDINGS` | `findings` で異常候補が 1 件以上見つかった |

### 環境変数

| 変数 | 既定値 | 内容 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | *(実行時必須)* | Jev（TypeSafe API）のキー。環境変数のみから読み、`.env` 等からは読まない |
| `TYPESAFE_MODEL` | `jev-latest` | TypeSafe API に送るモデル名 |
| `WEBHAND_HOME` | `~/.webhand` | ユーザーデータの保存ルート（`services/`, `memory/`, `runs/`, `state/`） |
| `WEBHAND_RUNS_KEEP_DAYS` | `30` | `start` が、この日数より古い実行フォルダを1日1回まで削除する。`0` ですべて残す |
| `WEBHAND_CHROME` | `auto` | `--chrome` の既定値（`auto`, `linux`, `windows`） |
| `WEBHAND_ENGINE` | `auto` | `--engine` の既定値（`auto`, `chrome`, `headless-shell`, `lightpanda`, `obscura`, `browser-run`, `kitesurf`） |
| `WEBHAND_FLOW` | `v2` | `start --flow` の既定値（`v2` または `v1`） |
| `WEBHAND_MEMORY` | `1` | `0` で flow v2 のサイト記憶の記録と提示を停止（互換名: `WEBHAND_KNOWLEDGE`） |
| `WEBHAND_MEMORY_USE` | `1` | `0` で記録は続けつつ Jev への提示だけを停止（互換名: `WEBHAND_KNOWLEDGE_USE`） |
| `WEBHAND_SCREENSHOTS` | *(無効)* | `1` で実行ログの隣に PNG スクリーンショットを保存（入力値も写る。Jev には送らない） |
| `WEBHAND_HEADLESS_SHELL` | *(自動検出)* | `chrome-headless-shell` バイナリの明示パス |
| `WEBHAND_OBSCURA` | *(PATH)* | `obscura` バイナリの明示パス |
| `WEBHAND_OBSCURA_ALLOW_PRIVATE` | *(無効)* | `1` で Obscura にループバック／プライベートアドレスへのアクセスを許可（ローカル専用） |
| `CLOUDFLARE_ACCOUNT_ID` | — | `--engine browser-run` / `kitesurf` で必須 |
| `CLOUDFLARE_API_TOKEN` | — | `--engine browser-run` / `kitesurf` で必須（"Browser Rendering - Edit"） |

### flow v1 と v2

`start --flow v2` が既定です。`--flow v1` または `WEBHAND_FLOW=v1` で、以前の流れを選べます。v1 は実験の基準として残しています。

| | v2（既定） | v1 |
| --- | --- | --- |
| Jev に出すもの | ページ全体の操作（画面外の要素は操作前にスクロールして見せる）とフレーム内の要素 | 見えている範囲と、エージェントが `--focus` / `--read` で選んだ領域 |
| Jev が進めないとき | Jev が `ESCALATE` もできる。エージェントが `answer`（`STUCK`、`BLOCKED`、`GOAL_REPORTED`、`JEV_FAILED` のあとも可）で答えると同じ試行が続く | 試行が `STUCK` か `BLOCKED` で終わり、エージェントが `replan` する |
| 鮮度の確認 | 操作対象（ページのキーと対象の guard）だけ。スクロールと待機は断らない | 観測したページ全体 |
| ページの状態 | `PAGE:` の行（`blocked`、`login`、`error` など）。対象が webhand に見えない部分（canvas、プラグイン）にあるときは止める | 出さない |
| 過去の実行 | 各ページ形でのクリックと選択の結果を記録し、同じ種類のページで、`done` で終わった実行の操作を（最大5件）Jev に示す | 使わない |

v2 が記憶するのは、`~/.webhand/memory/<host>.json` に置く、ページの種類（ID とクエリ値を除いたアドレス）と、そこで試した操作の種類とラベルだけです（旧 `~/.webhand/knowledge/` がある場合は初回アクセス時に自動で移行します）。入力した文、値、個人情報に見えるもの、リスト項目の中のコントロール（ラベルがページの内容）は残しません。`WEBHAND_MEMORY=0` で記録と提示を止め、`WEBHAND_MEMORY_USE=0` で Jev への提示だけを止め、`webhand memory clear` で消せます（旧名 `WEBHAND_KNOWLEDGE` / `WEBHAND_KNOWLEDGE_USE` も互換で有効）。

## 使い方を教える（記録と手順書）

人の操作、サービスのソースコード、または過去の実行ログから、次の2種類のファイルを作ります。

| ファイル | 内容 | 使われ方 |
| --- | --- | --- |
| `services/<service>/service.toml` | サービスの説明、`base_url`、任意の `allowed_domains`、ログイン要否、ページと領域、Jev 向けの事実 | `catalog` で読み、`--service` で渡す。`allowed_domains`（ホスト名のみ。例: `["app.example.com"]`）を書くと、`start` / `replan --url` / `answer --url` および許可外ドメインへのナビゲーション・リダイレクト・新規タブ遷移を拒否する |
| `services/<service>/checks/<name>.toml` | 保存した受け入れ確認（`status` は draft/approved、`env` は test/read-only、params、確認ごとの steps・`expect`・`manual`・`depends_on`）。実行では書き換えない。[design-regression.md](design/design-regression.md) | `webhand check --saved` と `/webhand-regress` で使用 |
| `services/<service>/runbooks/<name>.toml` | 手順書（`goal`, `start_url`, `status`, `params`, `steps`, `hints`, `done_when`, `focus`, `skip`） | エージェントの計画とバッチ実行（`webhand batch init`）の下敷き。手順と hints は Jev にも渡す |

### バッチ実行（`webhand batch`）

`webhand batch init --runbook SERVICE/NAME --input FILE.csv|FILE.json [--allow-draft] [NAME]` はブラウザ起動前に全行を検証し、パラメータ不足・未知列・未承認の `draft` 手順書・資格情報っぽい列名（`password`・`otp`・`cvv`・`card_number` 等）を拒否します。状態ファイル `~/.webhand/state/batches/<id>.json`（権限 `0600`）には入力ファイルパス・SHA-256 ダイジェスト・パラメータ名・各行の結果とログパスのみを保存し、**生の行データは複製しません**。各行は `webhand start --batch ID [--row N]` → `run` → 実画面確認 → `finish` で実行され、入力ファイルの改変検知と `done` / `uncertain` 行の再実行防止を自動で行います。

どちらも、プロジェクトの `.webhand/` かユーザーの `~/.webhand/` に置きます（「保存場所」）。`record` は書き込み先を `WRITE THE RUNBOOK TO ...` として表示します。`start_url` にローカルファイルの相対パスを書くと、その `.webhand/` を含むディレクトリからのパスになります。

```text
/webhand-teach --name myservice/search --url https://example.com
```

1. `webhand record` が Chrome を開き、ユーザーの操作を記録します。ウィンドウを閉じると終了します。ログインした状態で操作を見せる場合は、`--session profile:NAME` を付けます。バックグラウンドのジョブを止めても（SIGTERM、または npx の終了）、記録を保存して Chrome を閉じます。
2. エージェントが記録またはソースコードから、サービス情報と手順書の下書きを書きます。
3. `--runbook NAME --param k=v --allow-draft` で試行します。
4. ユーザーが内容を確認し、`status = "approved"` にします。

手順書は機械的に再生しません。

`sources` は任意の欄で、webhand は読みません。書くのは、誰でもたどれる参照（`code:<パス>@<commit>` など）だけです。実演、実行、試行は書きません。それらのログはユーザー側の `runs/` にしかないためです。実行ログには手順書の `digest` が残る（`run_start` と `run_end`）ので、ある版の手順書を使った実行はログから探せます。ファイルを変えるのは、記録したサービス情報や手順書の内容が変わるときと承認するときだけで、試行を記録するためには変えません。何を変えたかはコミットメッセージに書きます。

### まだ手順書のない手順

すでに覚えているサービスであれば、手順書のない手順も実行できます。エージェントが catalog から GOAL、開始 URL（サービスのページ一覧から選ぶ）、手順（`--step`）を書きます。`--runbook` がなくても、`--service SERVICE` でサービス情報が Jev に渡ります。

```text
webhand start --goal "..." --url "..." --step "..." --service myservice --session new
```

- そのまま効くもの: サービスの `facts`、`default = "skip"` の領域。
- 使えないもの: 手順書だけが持つ `hints`、`done_when`、`focus`。その分エージェントの計画に頼るため、計画の見直しが増えることがあります。
- 次回も使うなら、その実行の経験から手順書を作らせます（次の節）。`draft` の手順書になります。

### 実行の経験から覚える

`/webhand` の実行だけでは、保存済みのサービス情報や手順書は変わりません。計画を見直した、`blocked` で終わった、手順書なしで `done` になった実行では、エージェントがログの場所を伝えます。そのログから手順書やサービス情報に反映できます。

```text
/webhand-teach ~/.webhand/runs/<timestamp>/adhoc.jsonl
```

- エージェントは、自分が書いた見直しの理由（`attempt_end`）、`run` が止まった理由（`escalation`）、成功した試行で操作した要素と領域（`step`、`page`）を読みます。
- サービスの性質は service.toml の `facts` に、ひとつの手順に関することは手順書の `hints`、`steps`、`focus`、`skip` に書きます。手順書なしで `done` になった実行からは、新しい手順書を作れます。
- 根拠にするのはエージェントの理由とログの構造だけです。ページ本文は使いません。
- 変えた手順書は、`approved` だったものも `draft` に戻ります。試行してから承認してください。

記録の扱い:

- キー入力は記録しません。パスワード、ワンタイムコード、カード番号などの欄の値は `<redacted>` になります。ただし秘匿の判定は欄の属性と名前によるため、見分けられない欄の値は `runs/` の記録に残ります
- URL のクエリの値はすべて伏せます
- 記録はユーザー単位の `runs/`（既定は `~/.webhand/runs/`）に保存されます。ページ本文を含むため、共有しないでください
- iframe 内の操作とファイル選択は再現できないため、`unsupported` として残します
- 新しいタブは `tab` イベント（`opened`、`closed`。開いているタブの数つき。タブが前面に来たときは `switched`）として記録し、その中での操作は、そのタブの URL つきで通常どおり記録します。手順書には、そのタブへ切り替える手順を書きます（[タブ](#タブ)）。`switched` はページから届くので、ページが言えるのは自分のタブが前面に来たことだけです。ヘッドレスの Chrome では見えません
- ページのスクリプトは記録を偽装できるため、記録は信頼せず、手順書はユーザーが承認します

## ページの領域

観測は、テキスト 6000 文字、操作 250 件が上限です。ページは領域（header、nav、main、form、fieldset、table、dialog、ラベル付きの section など）に分けて観測します。領域のキーは、外側の領域からの並びです。

```text
main/form:宿泊予約/fieldset:追加プラン   # 種類:名前。名前は aria-label、legend、caption、領域の先頭の見出しから取る
nav#2                                    # 名前のない同じ種類が並ぶときは順番
```

- 観測結果の `regions` には、領域ごとに位置（`above` / `visible` / `below`）、テキストと操作の表示数と全数、画面外の操作の数が入ります。エージェントには `REGIONS`、Jev には `page.regions` として渡ります。何が切り捨てられたかがわかります。
- `focus` の領域は先頭に並び、テキストはページ全体から取ります。`skip` の領域は要約にだけ出ます。どちらもないときは、画面内を DOM 順に取ります。開いた dialog は、view があるときは常に先頭です。
- パターンはキーのどこに一致してもよく、一致した領域の内側も含みます。名前や番号のない段（`form`）は、その種類のどの領域にも一致します。focus と skip の両方に一致したら、深いほうが勝ちます（同じ深さなら focus）。
- flow v1 では、操作の対象は view に関係なく画面内だけです（v2 は画面外の要素も出します）。鮮度の判定（`marker`、`page_key`、`guards`）は、view に関係なく同じ入力から計算します。
- view は、service.toml の `default`、手順書の `focus` / `skip`、エージェントの `--focus` / `--skip` の順に重ね、後のものが勝ちます。`run_start` と `plan` のイベントに `view` が残ります。

```toml
# service.toml
[[pages.regions]]
key = "main/form:宿泊予約"
purpose = "予約フォーム"
[[pages.regions]]
key = "footer"
purpose = "サイト共通のリンク"
default = "skip"       # focus か skip。なしなら通常

# 手順書
focus = ["form:宿泊予約"]
skip = ["header", "footer"]
```

実演の記録では、`page` イベントに領域の要約（キーと件数だけ）、`action` イベントに対象の領域キーが入ります。秘密に見える名前の段は `form:<redacted>` になります。

`verify()` のないサービスでは `verified` は `null` です。手順書の `done_when` はエージェントの確認材料で、成功の証拠にはなりません。

## 画面の外を読む

flow v1 では（文章は v2 でも）、Jev とエージェントは、ふだんページの見えている部分しか受け取りません。よくあるページでは文章が500字ほどで、ページ全体には数万字あることもあります。`start` か `replan` に `--read KIND`（複数可）を付けると、観測のたびに、ページ全体から選んだ種類の内容を読み取り層として足します。エージェントは `run` と `observe` の出力の `READ` で、Jev は `page.read` で受け取ります。

| 種類 | 中身 |
| --- | --- |
| `outline` | 見出しとその階層。`--read` を付けると必ず入る |
| `text` | 表、リスト、見出し、リンク、操作要素の外にある本文 |
| `table` | 表ごとに、題名と、1行ずつの行（セルは ` \| ` で区切る） |
| `list` | 一番外側のリストの項目 |
| `link` | リンクの名前（同じ名前は1回だけ） |
| `control` | 画面外のボタン、入力欄などの操作要素。役割と名前だけ |
| `media` | 画像の代替テキストと図の説明 |

- 読むためだけのものです。この中のものは操作できません。flow v1 では、操作の対象と鮮度の確認は、下の `SCROLL_TO` を除いて見えている部分だけで決まります（v2 は画面外の要素も操作の対象にします）。`@ below 1200px` のような行は、その後の行がどこにあるかを示します。Jev はこれを見て、正しい方向へスクロールできます。
- 見えている部分にある本文、リストの項目、リンク、操作要素は入れません。画面内の文章と要素に、すでに入っているためです。見出しと表は、全体を入れます。
- 読み取り層は最大12,000字です。種類ごとに同じ量を割り当て、少なくて済む種類の残りをほかの種類に回します。行は途中で切りません。切った種類の最後には `... N more characters` が付きます。
- 読み取り層があるときは、画面外の要素（最大60個。近いものと遠いものを残す）を、`SCROLL_TO` の対象としてだけ、位置（`at="below 1200px"`）つきで渡します。`SCROLL_TO` はその要素を画面の中ほどまでスクロールするだけで、ほかには何もしません。次の観測で、その要素を操作できます。スクロールするたびに項目が増えるリストでは、最後の要素に `SCROLL_TO` すると次の項目が読み込まれます。エージェントも `webhand act SCROLL_TO N` で使えます。
- `--skip` の領域は読みません。`--focus` があるときは、その領域（と開いているダイアログ）だけを読みます。
- 入力欄の値は読みません。ページの内容は信頼しないデータとして扱います。
- `replan --read KIND` は種類の指定を置き換え、領域の指定は残します。`--read none` で読み取り層をなくします。`plan` イベントの `view.read` に指定が、`page` イベントの `read` に種類ごとの表示した字数と全体の字数が残ります。
- `--read` を付けなければ、観測、出力、Jev に渡すものは今までと同じです。

## 長い一覧から1つを選ぶ

目標が、一覧から条件で1つを選ぶことなら、`start` か `replan` に `--compare CRITERION`（例: `--compare "lowest monthly price"`）を付けます。各試行の最初の `run` は、何かを操作する前に、一覧全体を比べます。

1. webhand がページの一番上へ戻り、1画面ずつ下へスクロールします（前の画面と120px重ねる）。
2. スクロールのたびに、Jev が条件に一番合う項目を選びます。選択肢は、画面内の要素（その行、カード、リスト項目の文章つき）と、それまでの一番（`KEEP`）です。それまでの一番は文章で覚えておくので、画面外の行を消す一覧でも比べられます。まだ一番がないときは、`NONE` で「まだ合う項目がない」を選べます。
3. 20回スクロールしたとき、またはページの一番下で2秒待っても何も増えないとき（スクロールで増える一覧は、そこで増えます）に止まります。
4. 一番の項目があった位置へ（読み取り層があれば、その項目そのものへ）スクロールで戻り、いつもの手順に進みます。Jev は結果を `plan.compared` で受け取り、その項目を操作するよう規則で指示されます。その試行の残りでは、Jev の目標は GOAL ではなく、その項目になります。

比べている間は、クリックも入力もしません。このスクロールは操作の数に入れません。出力には `COMPARED (N scrolls, ...): 項目` が出ます。ログには、スクロールごとの `compare_round` と、最後の `compare_end` が残ります。比較に失敗したときは `compare_failed` を残し、何も変えません。新しい試行のたびに比べ直します。`replan --compare none` で止めます。スクロールするのはページ全体だけで、ページの中のスクロールする枠は対象外です。

## 長い一覧から条件に合うものをすべて集める

目標に、一覧のうち条件に合う項目がすべて要るなら、`start` か `replan` に `--collect CONDITION`（例: `--collect "200 GB of storage and less than €40 a month"`）を付けます。各試行の最初の `run` は、それらを集めて止まります。

1. webhand が `--compare` と同じ手順でスクロールします。一番上から1画面ずつ下へ進み、20回スクロールしたとき、または一番下で待っても何も増えないときに止まります。
2. スクロールのたびに、画面内の一覧と表の項目（表の行と、同じタグとクラスで3つ以上並んだまとまり。div で組んだカード、リスト項目、記事など。メニュー、ヘッダー、フッター、見出しの行は除き、入れ子になったものは外側のほう、たとえばカードの中の箇条書きではなくカードを読みます）を読みます。まだ見ていない項目は1回ずつ Jev に聞き、その項目の文章から `MATCH` か `NO` で判定させます。Jev に渡すのは計画と条件だけで、ページは渡しません。
3. 合った項目は文章で覚えておくので、画面外の行を消す一覧でも集められます。
4. その試行の残りでは、Jev は GOAL の代わりに、エージェントの手順とエージェントが書いた値に向かって操作します。GOAL のうち一覧を読む部分は済んでいるからです。手順がなければ GOAL のままです。

集めている間は、クリックも入力もしません。集め終わると `run` は止まります。出力には `COLLECTED (N scrolls, ...): M of S items meet: 条件` と、合った項目が1行ずつ（最初の100件まで）出ます。エージェントはそれを目標と照らし合わせ、答えを書きます。答えをページに入れるときは、値として渡します（`run --value 'LABEL=VALUE'`）。次の `run` は、集める前の位置から、いつもの手順に進みます。ログには、スクロールごとの `collect_round` と、件数を記した `collect_end` が残ります。集めるのに失敗したときは `collect_failed` を残し、何も変えません。新しい試行のたびに集め直します。`replan --collect none` で止めます。`--compare` と `--collect` は一緒に使えません。表の行、リスト項目、記事でない項目は読まず、スクロールするのはページ全体だけです。

## ボタンや次のページの先にある項目

`--compare` か `--collect` と一緒に、`start` か `replan` に `--more CONTROL`（例: `--more "Next page"`、`--more "Show more plans"`）を付けると、一覧の続きを出す操作の名前を指定できます。

1. 一覧の終わり（ページで一番長い一覧の最後の項目が画面に入ったところ。その下が見えるところまで先にスクロールします）と、一番下で待っても何も増えないときに、画面内の要素（周りの文章つき）からその操作に当たるものを、Jev が選びます。なければ `NONE` です。この質問では、Jev にページも渡します。同じ場所では1回だけ聞きます。
2. webhand がそれを1回押し、ページが変わる（アドレスが変わる、内容が増える、文章が変わる）のを最大3秒待ってから、今の画面から続けます。変わらないときと `NONE` のときは、一覧の終わりからはそのままスクロールを続け、一番下で止まります。
3. 1回の走査で押すのは10回までです。

押すのは操作なので、繰り返しません。押した結果が不確かなら、`UNCERTAIN` で止まります。`--compare` で一番の項目が前のページにあったときは、そのページを開き直してから（一度開いたページです）、その項目へスクロールします。ボタンで増やした一覧は、そこでは増やし直しません。`--collect` で別のページで終わったときは、そのページの一番上で終わります。出力には `loaded more N times` が加わり、ログには押すたびに、何が変わったかを記した `more` が残ります。`replan --more none` で止めます。`--compare` も `--collect` もないときの `--more` は断ります。

## タブ

クリックで新しいタブが開くことがあります（`target="_blank"`、`window.open`）。webhand は実行を一度に1つのタブに置き、新しいタブは、切り替えるまで観測しません。

- タブが2枚以上開いているときだけ、観測に `TABS: N open, this is tab K` が出て、ほかのタブが操作 `TAB_n`（「Switch to tab n: タイトル」）として並びます。Jev は `SCROLL_DOWN` や `WAIT` と同じように番号で選びます。タブが1枚なら何も変わりません。`webhand act TAB_2` で手動でも切り替えられます。
- 切替は、タブの数、並び、切替先のタイトルが観測時と同じときだけ実行します。違えば何も実行せず、結果は `STALE` です。切替でどのページも変わりません。
- 新しいタブ、閉じたタブ、切り替えたタブは、ページが変わったものとして数えるので、`STUCK` を増やしません。
- 今のタブが自分で閉じたら、残っている最後のタブに移ります。
- 今のタブは、コマンドのたびに Chrome へ接続し直すため、`state/tab` に残して次のコマンドへ引き継ぎます。
- ほかのタブのタイトルは、観測とともに Jev に送られます（ページ本文なので、信頼しないデータです）。保存プロファイルでは、ログイン中のタブも含みます。
- 未対応: タブを閉じる操作と、クリックで開いたタブへの自動切替。

## ログ

ユーザー単位の `runs/<時刻>/`（既定は `~/.webhand/runs/`）に JSONL で出力されます。

| type | 内容 |
| --- | --- |
| `run_start` | 目標、Chrome（linux / windows）、セッションの種類、git commit、手順書、サービス |
| `start_failed` | `start` がページを開けなかった理由（エラーの1行目。URL の値は伏せる）、開始 URL、Chrome、セッションの種類。この実行には `run_start` がない |
| `plan` | 試行ごとの手順、入力値のラベル、その出所（`claude` / `runbook`）、`restart` |
| `call` | Jev の呼び出しごとのトークンと遅延 |
| `step` / `step_result` | 実行した操作、その領域、入力した値のラベル（値そのものは残さない）と `text_chars`、試行番号、判断者、確信度、ページの変化。URL のクエリ値は伏せる |
| `page` | 開始時とページが変わるたびの領域の要約（キーと件数だけ。本文は入れない）。`--read` があるときは、`read` に種類ごとの表示した字数と全体の字数が入る |
| `escalation` | `run` がエージェントに返した結果 |
| `human_step` / `values` | 人の手順の依頼と完了、追加された入力値のラベル |
| `attempt_end` | 試行の結果と、エージェントが書いた見直しの理由 |
| `handoff` | エージェントが読む CLI 出力の文字数 |
| `screenshot` / `screenshot_failed` | `WEBHAND_SCREENSHOTS=1` のときだけ。画像がどの手順と試行のあとか、何のあとか（`start` / `action` / `restart`）、`<ログ名>-screenshots/` 内のファイル、クエリ値を伏せた URL。撮影に失敗しても記録して実行を続ける |
| `page_check` / `page_check_failed` | `start` のあと（`when: start`）と、`run` が `BLOCKED`、`STUCK`、`ATTEMPT_BUDGET`、`NEEDS_HUMAN` で止まったとき（`when: escalation`）。試行、クエリ値を伏せた URL、文書の HTTP ステータス、ページの題名（120文字まで）、見つかったボット確認の目印（`cloudflare`、`recaptcha`、`hcaptcha`、`datadome`、`perimeterx`、`arkose`。目印であって証拠ではない）、表示されている文字数。読むだけで、Jev には送らない。確認に失敗しても記録して実行を続ける |
| `run_end` | 自己申告の状態とエージェントの `reason`、サービス、手順書、独立検証の結果、試行回数と試行ごとの結果、`actions`（実行した操作だけ）、`stale` と `not_visible`（実行しなかった選択）、役割ごとの集計 |

成功判定は `run_end.verified` です。`status=done` は申告にすぎません。コーディングエージェントのトークン数は取得しないため、`handoffs`（エージェントに戻した回数）と `handoff_chars`（読ませた文字数）を代理指標にします。

## アップロードとダウンロード

- **アップロード**: 見えている `<input type="file">` を `UPLOAD_FILE` として出します。Jev が使ってよいファイルは、エージェントが `--file "ラベル=パス"` で渡します（`start`、`run`、`answer`、`replan`）。Jev が選ぶのはラベルだけで、パスは見えません。ファイルはカレントディレクトリの下にあるものに限り、保存した状態と `.env` は拒否します。エージェント自身がやるときは `act UPLOAD_FILE N --file ラベル`。ページが隠している file 入力（ボタンから開くもの）は、まだ出しません。
- **ダウンロード**: `start --download-dir DIR` で、クリックでダウンロードされたものを DIR に保存します（同名があれば ` (1)` を付けます）。`act` は `DOWNLOADED: 名前 (bytes)` を出し、ログと Jev の履歴のステップに `downloads` が残ります。中身の確認はエージェントが行い、Jev には送りません。クリックから1.5秒より後に始まるダウンロードは、そのステップでは見えません。
- どちらもローカルの Chrome が必要です（Linux の `--engine chrome`、または `headless-shell`）。ダウンロードは Windows の Chrome、`lightpanda`、`obscura`、Cloudflare の engine では使えません。
