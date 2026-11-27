# webhand の開発

[English](DEVELOPMENT.md) | 日本語

webhand 自体に変更を加える人向けのガイドです。インストールと使い方は [README.ja.md](README.ja.md) と [docs/usage.ja.md](docs/usage.ja.md)、完全な CLI・ファイル仕様は [docs/reference.ja.md](docs/reference.ja.md)を参照してください。

webhand は、npm で CLI を配布する複数エージェント向けプラグイン／スキル群（Claude Code・Antigravity・OpenAI Codex CLI などの Agent Skills 対応ツール）であると同時に、研究基盤でもあります。「人がサービスに慣れるように、使い方を覚えてから操作するほど成功する」という仮説を検証し、成功は独立検証（`verify()`）のみで判定し、失敗実行も除外しません。下の規則の多くは、コードの保守だけでなく実験の妥当性を守るためのものです。

## セットアップ

必要なもの: Node.js 24（パッケージ対応は 22 以上、CI は 24）、Google Chrome、git。

```bash
npm ci                         # husky の pre-commit フックも入る
npm run build && npm link      # webhand コマンドをこの作業ツリーのビルドに向ける
webhand doctor                 # Node・Chrome/WSL・TYPESAFE_API_KEY・環境を診断
claude --plugin-dir .          # Claude Code: このチェックアウトのスキルを読み込む
agy plugin validate .          # Antigravity: プラグイン設定・スキル・ルート hooks.json を検証
agy plugin install .           # Antigravity: このチェックアウトをローカルプラグインとして導入
```

Codex CLI では、このディレクトリをローカルマーケットプレイスとして追加（`codex plugin marketplace add .`）するか、チェックアウト内の `.agents/skills/` を直接使います。なお、このマルチエージェントリポジトリでは `agy plugin validate . --strict` が 2 件の想定内警告（ルートの `AGENTS.md` は開発者向け規則、`hooks/hooks.json` は Claude Code 用で Antigravity はルート `hooks.json` を読む）を出します。

このリポジトリ内でスキルの `npx -y webhand@<版>` を実行すると、`<版>` がこのチェックアウトの版に合う場合は `webhand: not found` になります（npm が、`package.json` の版を持つこのリポジトリ自体で指定が満たされると判断し、ローカル `node_modules/.bin` を探すため）。`npm link`（スキルが `webhand` を直接呼ぶ）か `npx -y webhand@latest` を使ってください。

実行ログをリポジトリ内に残したいときは、シェルの環境変数 `WEBHAND_HOME` にこのリポジトリの絶対パスを設定するか、Claude Code の `.claude/settings.local.json`（コミットしない）に書きます：

```json
{ "env": { "WEBHAND_HOME": "/absolute/path/to/this/repository" } }
```

この設定では、ユーザー側の手順書も `~/.webhand/services/` ではなくリポジトリ内の `services/`（git 管理外）から読まれます。

### 開発・テスト用の環境変数

ユーザー向けの全環境変数（`TYPESAFE_API_KEY`・`TYPESAFE_MODEL`・`WEBHAND_HOME`・`WEBHAND_CHROME`・`WEBHAND_ENGINE`・`WEBHAND_FLOW`・`WEBHAND_MEMORY`・`CLOUDFLARE_*` 等）は [リファレンス — 環境変数](docs/reference.ja.md#環境変数) を参照してください。開発・テスト専用の変数は次のとおりです：

| 変数 | 用途 |
| --- | --- |
| `WEBHAND_LOG` | ログファイル出力先の上書き（テスト用） |
| `WEBHAND_SCREENSHOTS` | `1` にすると開始時・各操作後・`replan --restart` 後に `<log>-screenshots/` へ PNG を保存（既定オフ。stdout や Jev 入力は不変） |
| `WEBHAND_SETTLE_QUIET_MS` | 観測ごとの静定待ち時間（ms）。`vitest.config.ts` は `40`、製品の既定は `150` |
| `WEBHAND_STARTUP_MS` | ブラウザ起動タイムアウト（ms）。`vitest.config.ts` は `45000`、製品の既定は `15000` |

## リポジトリ構成

```text
src/                 CLI 本体（`npm run build` で dist/ として配布）
  bin.ts             エントリポイント。CliExit / UsageError を終了コードに変換
  cli.ts             トップレベルのコマンド振り分け、セッションロック、handoff 計測
  args.ts            宣言的なオプション／位置引数パーサとヘルプ生成
  output.ts          エージェント向けの画面・計画・操作履歴の整形
  explore.ts         ホスト許可リスト（parseHostList/parseAllow/hostAllowed）と探索 findings
  record.ts          人の実演操作の録画
  agent/             Jev ループ（観測→選択→実行）。結果コードのみ返し、成功を主張しない
  browser/           Playwright + CDP セッション（観測、操作、鮮度確認、DL、タブ、探索監視）
  check/             決定的な受け入れ照合（`webhand check`）
  commands/          各 CLI コマンド定義（`catalog`, `doctor`, `start`, `run`, `answer`, `replan`,
                     `act`, `observe`, `check`, `extract`, `findings`, `checklast`, `finish`, `record`,
                     `auth`, `batch`, `memory`, `profile`）。`commands/index.ts` に登録
  core/              共通エラー、型、整形、原子的ファイル書込、JSONL メトリクス、ワークスペース解決
  engines/           ブラウザエンジン（`chrome`, `headless-shell`, `lightpanda`, `obscura`, `browser-run`, `kitesurf`）
  extract/           決定的な DOM 抽出器（`table`, `list`, `link`, `fields`, `text`）と出力形式（`table`, `json`, `csv`, `markdown`）
  har/               セッション単位の常駐 CDP HAR 1.2 記録（`--har`）
  ipc/               ステートレスエンジン（Lightpanda・Obscura）向けの常駐デーモン＋Unix ソケット
  policies/          行動空間・モデル state（`base.ts`）、Jev クライアント（`jev*.ts`）、テスト用ダブル
  scans/             一覧全体のスキャン（`--compare`, `--collect`, `--more`）
  storage/           TOML 手順書（`runbook/`）、保存チェック（`checkfile.ts`）、バッチキュー（`batch.ts`）、
                     保存ログイン（`auth.ts`）、サイト記憶（`memory.ts`）、セッション状態（`session.ts`）
assets/              Chrome に注入するスクリプト（`snapshot/`, `extract.js`, `recorder.js`）
skills/              配布スキル（`webhand`, `webhand-teach`, `webhand-extract`,
                     `webhand-explore`, `webhand-verify`, `webhand-regress`）
examples/services/   コピーしてすぐ使えるスターター `service.toml`・`draft` 手順書・サンプル CSV
hooks.json           Antigravity ネイティブプラグインの PreToolUse フック（`--allow-control` 確認）
hooks/               Claude Code の `hooks.json` と共通スクリプト `ask-allow-control.mjs`
.claude-plugin/      Claude Code プラグイン／マーケットプレイス設定
.antigravity-plugin/ Antigravity ネイティブプラグイン設定
.codex-plugin/       Codex プラグイン設定
.agents/             Codex マーケットプレイス設定と研究用スキル（`.claude/skills/` からシンボリックリンク）
.webhand/services/   このリポジトリ自身の手順書
research/            研究専用エントリポイント（`webhand.ts`, `tasks.ts`, `batch.ts`, `smoke.ts`, `progress.ts`, `webarena/`）。配布外
tasks/               独立検証 `verify()` つき研究タスクとローカル HTML フィクスチャ。配布外
tests/               vitest テストスイート、golden 基準出力（`tests/golden/`）、テストダブル（`tests/jev.ts`）
scripts/             CI・パッケージ検証スクリプト（`check-package.ts`, `coverage-summary.ts`）
docs/                案内図（`README.md`）、ユーザー文書（`usage*.md`, `reference*.md`）、
                     メディア（`media/`）、設計記録（`design/`）、研究記録（`research/`）
```

## 実行の流れ

各 CLI 呼び出しは 1 回ごとに終わる短いプロセスです。コマンド間で保つ状態（Chrome のデバッグ接続先、計画、操作履歴、試行回数、現在のタブ。`--id` ごとに独立）はユーザーフォルダの `state/` に保存します。

1. `start` が計画（`--runbook`・`--batch`・`--service`・`allowed_domains` の解決を含む）を保存し、`session.startChrome` でブラウザを開きます。
2. `run` がそのブラウザに接続し、`agent.runAgent` が `Browser.observe` → `Policy.choose` → `agent.execute` → `Browser.act` を回します。
3. ループはいずれかの結果（`GOAL_REPORTED`, `NEEDS_VALUE`, `NEEDS_HUMAN`, `ESCALATE`, `BLOCKED`, `STUCK`, `ATTEMPT_BUDGET`, `JEV_FAILED`, `UNCERTAIN`）を返し、`commands/report.ts` がエージェント向けに出力します。
4. エージェントは `answer`、`replan`、`act`、`observe`、`check`、`extract`、`findings`、`run --value`、`run --human-done`、または `finish` を呼びます。`finish` は（研究ラッパーが `verify()` を渡したとき）独立検証を走らせ、紐づくバッチ行を更新し、HAR をフラッシュして `run_end` を記録し、ブラウザを閉じます。

終了コード（`src/commands/context.ts`）: `0` 正常、`1` 失敗 / `CliExit`、`2` 引数エラー、`3` 鮮度切れ（`STALE`）、`4` 変更結果不明（`UNCERTAIN`）、`5` 予算上限（`BUDGET`）、`6` チェック失敗 / 件数不一致、`7` 判定不能（`INCONCLUSIVE`）、`8` 部分抽出（`EXTRACT_PARTIAL`）、`9` 探索候補あり（`FINDINGS`）。

## 破ってはいけない規則

[AGENTS.md](AGENTS.md) に基づきます。これらを弱める変更は採用しません。

**役割**

- GOAL と手順の計画、入力値、完了確認、計画の見直し、最終判断はホストエージェント、GOAL までの操作選択は Jev が担う。どちらか一方に集約する設計へ戻さない。
- 計画側は作業中のコーディングエージェント（Claude Code・Antigravity・Codex 等）がスキル経由で担う。`ANTHROPIC_API_KEY`・`OPENAI_API_KEY`・`GEMINI_API_KEY`、各社 SDK、`claude -p`・`codex exec`・`agy -p` の直接呼び出しを使わない。

**実行**

- モデルには観測済み要素の番号とホストエージェントが書いた入力値の番号だけを選ばせる。セレクタ、座標、コード、入力文を出力させない。
- ブラウザへの変更操作はリトライしない。結果が不確かなら `MutationUncertain` で停止し、計画の見直しもしない。再挑戦はホストエージェントが `replan` で回数上限つきで行う。
- 操作の直前に鮮度を確認する。入力はすべて `Browser.act` を経由する。
- ページ本文は信頼しないデータとして扱う。password 欄の値は読まない。
- 既定は使い捨てプロファイル。ログイン状態は webhand 専用の保存プロファイル（`profile:NAME`）か所有者限定の `--auth` でのみ扱い、普段使いの Chrome プロファイルには接続しない。資格情報は人が Chrome に直接入力する。
- 手順書とサービス情報に秘密情報・個人情報を書かない（値は `params`）。`draft` は通常実行に使わず、承認（`approved`）はユーザーのみが行う。

**実験**

- 成功判定はタスクの `verify()` のみ。`DONE` / `status=done` は申告であり証拠ではない。
- 実験ごとに変える変数は 1 つ。失敗実行もログから除外しない。
- 検証に失敗した方式に合わせてタスクや検証を緩めない。

## チェック

```bash
npm run lint             # Biome（フォーマット＋リント）
npm run typecheck        # tsc --noEmit
npm run knip             # 未使用ファイル・export・依存関係の検出
npm run check            # 上の 3 つを一括実行
npm test                 # vitest（Linux Chrome 使用、有料 API 呼び出しなし）
npm run test:coverage    # coverage/index.html（合格ライン: 各 70%）
npm run build && npm run check:package   # npm 配布物の内容検証
npm run smoke -- --task hotel_filter     # モデルなしの SCRIPT スモーク実行
```

- husky の pre-commit フックと GitHub Actions で `npm run check` と `npm test` が必ず走ります。`--no-verify` で回避しないでください。
- テストファイルは並列実行されます（`vitest.config.ts` で `fileParallelism: true`、ローカル最大 6 ワーカー / CI 最大 3 ワーカー）。各テストファイルは 1 テーマに絞り、ワーカー間で偏らないようにしてください。
- `vitest.config.ts` は `WEBHAND_SETTLE_QUIET_MS=40` を設定してフィクスチャの静定待ちを短縮しています（製品の既定は `150` ms）。静定挙動そのものを検証するテストでは自分で `WEBHAND_SETTLE_QUIET_MS=150` を指定してください。
- カバレッジの合格ラインは lines・statements・functions・branches とも 70%（`vitest.config.ts`）で、下回ると CI が失敗します。

### コードスタイル

- TypeScript、ES modules、`strict`。import には `.ts` 拡張子を付け、`tsc` が `dist/` 用に書き換えます。
- `erasableSyntaxOnly`：enum・namespace・parameter properties は使いません（`tasks/` は Node の型ストリッピングで直接読むため同様）。
- Biome：インデント 2、行幅 120、import 整列。`biome-ignore` には理由を添えます。
- 各モジュールの先頭に責務を 1〜2 文のコメントで書き、コメントは「なぜ」を中心にします。

## テスト

- `tests/setup.ts` が各テストへ専用の `WEBHAND_HOME` を割り当て、`WEBHAND_ENGINE=chrome` に固定し、`deps.policy` を例外送出関数に差し替えるため、テストから Jev を呼んだり個人の `~/.webhand` を読んだりしません。
- `tests/jev.ts` は `ScriptedJev` と `isolate()` を提供します。`ScriptedJev.moves` に `[操作, 要素ラベル, 値ラベル]` を設定し、`ScriptedJev.plans` / `states` で Jev に渡った内容を検証します。
- `tests/helpers.ts` は `cli(...)`、`cliExit(...)`、`research(...)` / `researchExit(...)`、`readEvents(log)`、`tmpPath()`、`inDirectory(dir, fn)` を提供します。
- ブラウザテストは実際の Linux Chrome を並列（`fileParallelism: true`、タイムアウト 60 秒）で動かします。Chrome がリークしないよう、必ず `isolate()` の `cleanup()` を呼んでください。
- フィクスチャは `tasks/fixtures/` 配下のローカルファイルです。外部ネットワークや有料 API は使いません。

### golden 出力

`tests/golden/cases.json` は基準出力を保持し、`tests/golden.test.ts` が文字単位で比較します（`render`・`report`・`describePlan`・Jev の state と質問・リポジトリ内手順書一覧など）。エージェントや Jev が読む文字列は実験の変数の一部です。

- エージェント表示や Jev 送信に使う値はテンプレート文字列の既定変換に頼らず、`src/core/format.ts` の `quote`・`show`・`toJson` を使ってください（`toJson` は `Map` の順序を保ちます）。
- 意図的に変更する場合は実験の変数として扱い、`npm run test:golden:update` で更新し、`cases.json` の差分を確認して理由をコミットメッセージに残してください。`tests/golden/pages.json` は固定入力です。

## 追加するとき

- **CLI コマンド・オプション**: `src/commands/` に `CommandDef` を定義して `src/commands/index.ts` に登録し、`tests/` にテストを追加したうえで、`docs/reference.md`・`docs/reference.ja.md`・`docs/usage.md`・`docs/usage.ja.md` と対応する `skills/` を更新します。
- **研究タスク**: `tasks/<name>.ts` を作り、`GOAL`・`startUrl(root)`・`{ success, evidence }` を返す `verify(browser)`・`SCRIPT`（`npm run smoke` 用）を export します。フィクスチャは `tasks/fixtures/` へ置き、Node 22.18+ の型ストリッピングで動く構文のみ使います。実行は `/webhand-research NAME`（`.agents/skills/webhand-research`、`.claude/skills/` へシンボリックリンク）。`tasks/` と `research/` は npm 配布物に含めません。
- **タスクの一括実行**: herdr を起動した状態で、リポジトリのルートから `node research/batch.ts (--tasks A,B | --webarena 0,11) --model MODEL --out DIR [--repeat N] [--parallel N] [--serial A,B] [--full]`。起動元の herdr ワークスペースに新しいタブを作り、進捗パネル（`research/progress.ts`）と実行用パネル（`--parallel`、既定 3）を開き、実行ごとに新しい対話の `claude` を起動します（起動文は `/webhand-research NAME (session: new)` か `/webhand-webarena-research ID (session: new) …`、`WEBHAND_HOME` は DIR 下の実行専用）。呼び出し側の `WEBHAND_SCREENSHOTS` は各セッションに渡します（画面は実行ログの横の `<log>-screenshots/` に保存）。`--serial` のタスクは他がすべて終わってから 1 件ずつ実行します（サイトのデータを変えるタスク）。AskUserQuestion には固定文を自動回答し（`research/auto-answer.ts`、行の `auto_answers` に件数）、権限確認と文章での質問には回答しません。2 つの研究スキルは、複数タスクを指定するとこれを使います。`--webarena` は `--repeat` を指定できず、`WEBARENA_DATASET`・`WEBARENA_CONFIG` をペインに渡し、データセット・設定・他の実行記録の読み取りを拒否し、最後に `eval` と `report` を実行します。20 分で `run_end` がない実行は記録して次へ進み、再試行しません。結果は `DIR/results.jsonl` に 1 実行 1 行（`tasks/` の成功は `verified` のみ。WebArena の行の `verified` は null で、得点は別の指標です）。再実行すると行のある実行は飛ばします。未コミット変更・未追跡ファイルがある場合と、DIR の行や次の実行の commit が違う場合は停止します。既定は軽量構成（ツールを限定し、同梱スキルを無効化）、`--full` はその 2 つを残します。ほかは同じです: `--setting-sources project`（ユーザーとローカルの設定・hooks・プラグイン・スキル・同期スキルを読まない）、`~/.claude/**` の `claudeMdExcludes`、`--permission-mode auto`、`--strict-mcp-config`、auto memory 無効。管理設定、ログイン、リポジトリより上のほかのフォルダの `CLAUDE.md` / `AGENTS.md` は適用されます。各行には `claude_version` と `batch_node_version`（batch プロセスの Node）も記録します。DIR はリポジトリ外か git の無視対象にします。前提と他のエージェント向けの未確認項目は[一括検証の前提](docs/research/batch-verification.md)を参照してください。
- **実行の進捗を見る**: 別の端末で `node research/progress.ts [--tasks LIST | --research N --webarena N | --total N] [--since WHEN] [--dir DIR]...` を実行すると、起動後（または `--since` 以降）に始まった `/webhand-research` と `/webhand-webarena-research` のランを一覧で表示する。スキルごとの予定・完了・実行中・未開始、`verify()` の結果（`verified` が true のときだけ OK）と WebArena の得点（`eval_result.json` の score だけ）を別に数え、OK でなかったランの種別、実行中のランごとに動いているか止まっていそうか、予定を渡したときは完了予定時刻を出す。`run_end` もセッションもないランは中断として数え、再実行は予定の枠を使わない。`--events` か `--log FILE` ではイベントを1行ずつ表示する。読むのはセッション状態とそのロック、実行ログ、その得点だけ。`--dir` を省くと `$WEBHAND_HOME`、`~/.webhand`、checkout を探す。ページ本文、値、verify() の evidence、正解は表示しない。
- **手順書**: `.webhand/services/<service>/runbooks/`（またはスターター例は `examples/services/`）に置きます。初期状態は `status = "draft"` とし、承認はユーザーのみが行います。
- **ポリシー（実験アーム）**: `src/core/types.ts` の `Policy` を実装し、`src/policies/base.ts` の `actionSpace`・`modelState`・`resolve` を再利用して全アームが同じ行動空間と state を見るようにします。

## コミットとプルリクエスト

- `main` からブランチを切り、CI を通します。
- `.env`、`runs/`、`state/`（保存プロファイル・ログイン・バッチ状態を含む）、`.claude/settings.local.json` はコミットしません（`.gitignore` 済み）。
- 日英ドキュメントは常に同期を保ちます：`README.md` / `README.ja.md`、`docs/usage.md` / `docs/usage.ja.md`、`docs/reference.md` / `docs/reference.ja.md`、`DEVELOPMENT.md` / `DEVELOPMENT.ja.md`。

## リリース

```bash
node scripts/release.ts X.Y.Z --dry-run   # 読み取りのみ：今の段階と残りの操作を表示
node scripts/release.ts X.Y.Z
```

作業ツリーが clean で依存をインストール済みのチェックアウトで、書き込み権限のある `gh` にログインして実行します（リリースの commit で pre-commit の check とテストが走ります）。スクリプトは次を行います。

1. `origin/main` から `release/X.Y.Z` を作り、`npm version X.Y.Z --no-git-tag-version`、commit、push して pull request を作ります。
2. すべてのチェック（ruleset で必須でないものを含む `check`・`package`・`test`・`verify-tasks`）の完了を待ち、1回だけ確認してから、検査した head をマージします。
3. マージ commit に GitHub Release `vX.Y.Z` を自動生成のノート付きで公開します。これで `.github/workflows/release.yml` が起動します。

**続けて、`npm` environment の承認をすぐ行ってください。** マージから公開までの間、`main` のスキルは npm にまだない版を指定するため、`npx` が失敗することがあります。

途中で止まると、何が残っていて次に何をするかを表示します。同じコマンドをもう一度実行すると、すでにある branch・pull request・マージ・タグから続けます。削除や force push はしません。公開そのものが失敗したときは失敗した job を再実行し、コードが原因ならタグは動かさず、直して次の patch 版をリリースします。

`npm version` は `package.json`、`package-lock.json`、3つの `plugin.json`、スキルが実行する版をまとめて更新します（`scripts/sync-version.ts`）。手で実行するときはフラグを外さないでください。外すと npm は `package.json` と lock だけを commit します。`node scripts/sync-version.ts --check` で版がずれたファイルを確認でき、ずれがあれば `tests/version.test.ts` が失敗します。他のページは `webhand@latest` と書きます。

`release.yml` はタグと全マニフェストの一致・`main` ブランチであることを確認し、テスト実行後に npm trusted publishing で公開します（ローカルから `npm publish` しないでください）。`prepublishOnly` が `npm run check && npm run build && npm run check:package` を実行し、配布物が `dist/`・`assets/`・ライセンス・README だけであることを保証します。

## サードパーティのコード

`assets/snapshot/`、`src/policies/base.ts`、`src/policies/jev.ts`、`tasks/fixtures/hotel.html` は [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT）を改変したものです。帰属コメントと `THIRD_PARTY_LICENSE_jev-ultrafast.txt` を保持してください。
