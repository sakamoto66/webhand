# webhand の開発

[English](DEVELOPMENT.md) | 日本語

webhand 自体を変更する人向けのガイドです。インストールと使い方は [README.ja.md](README.ja.md)、実験設計は [docs/research-plan.md](docs/research-plan.md) を参照してください。

webhand は npm で配布する Claude Code プラグインであると同時に、研究基盤でもあります。研究では「AI も人と同じように、サービスを学ぶほど操作の成功率が上がる」という仮説を確かめます。成功は独立した検証だけで判定し、失敗した実行も残します。以下の規則の多くは、コードの整理のためだけでなく、実験の妥当性を守るためにあります。

## セットアップ

必要なもの: Node.js 24（パッケージは 22 以降に対応、CI は 24）、Google Chrome、git。

```bash
npm ci                         # husky の pre-commit フックも入る
npm run build && npm link      # webhand コマンドを作業ツリーのビルドに向ける
claude --plugin-dir .          # このチェックアウトのスキルを読み込む
```

このリポジトリ内では `npx -y webhand@0.2` が `webhand: not found` で失敗します。npm がリポジトリ自身（`webhand@0.2.0`）を指定に合うものとみなし、ローカルの `node_modules/.bin` から bin を探すためです。`npm link` を使う（スキルは `webhand` を直接実行する）か、`npx -y webhand@latest` を使ってください。

実行ログをリポジトリ内に残すには、`.claude/settings.local.json`（コミットしない）に次を書きます。

```json
{ "env": { "WEBHAND_HOME": "/このリポジトリの絶対パス" } }
```

このときユーザー単位の手順書は `~/.webhand/runbooks/` ではなく、リポジトリの `runbooks/`（git 管理外）から読みます。

### 環境変数

| 変数 | 用途 |
| --- | --- |
| `TYPESAFE_API_KEY` | Jev の API キー。環境変数からだけ読み、`.env` などのファイルからは読まない |
| `TYPESAFE_MODEL` | Jev のモデル |
| `WEBHAND_HOME` | ユーザーフォルダー（既定は `~/.webhand`） |
| `WEBHAND_CHROME` | `auto` / `windows` / `linux`（`--chrome` と同じ） |
| `WEBHAND_LOG` | ログファイルの出力先の上書き（テストで使う） |

## リポジトリ構成

```text
src/                 CLI（ビルド後 dist/ として配布）
  bin.ts             エントリーポイント。CliExit / UsageError を終了コードに変換
  cli.ts             全コマンド、引数解析、Claude が読むテキスト
  agent.ts           Jev のループ（観測・選択・実行）。結果を返すだけで成功は主張しない
  browser.ts         Playwright と CDP セッション1本。観測、入力、鮮度確認
  session.ts         CLI 呼び出しをまたいで生き続ける Chrome、保存プロファイル、実行状態
  runbook.ts         サービス情報と手順書（TOML）、ビュー（focus / skip）
  learn.ts           人の操作の記録
  workspace.ts       プロジェクト（.webhand/）とユーザー（~/.webhand/）のフォルダー
  metrics.ts         追記専用の JSONL ログ、トークン集計、git の状態
  format.ts          Claude と Jev が読む値の引用と compact JSON、実行フォルダー名
  types.ts           共有の型とエラー（StalePage、MutationUncertain、PolicyError）
  policies/
    base.ts          全方式で共通の行動空間、状態、指示
    jev.ts           TypeSafe API 経由の Jev
    scripted.ts      タスクファイルの固定手順。ハーネスの確認専用
research/            研究専用の入口。配布しない
  webhand.ts         CLI に --task を足したもの。start はタスクの GOAL を使い、finish は verify() を走らせる
  tasks.ts           研究用タスクの読み込み
  smoke.ts           モデルを使わないスモークテスト（npm run smoke）
assets/              Chrome に注入するページスクリプト（snapshot.js、recorder.js）
skills/              Claude Code のスキル（webhand、webhand-learn）
.claude-plugin/      プラグインとマーケットプレイスのマニフェスト
.webhand/runbooks/   このプロジェクトの手順書
tasks/               独立検証 verify() を持つ研究用タスク。配布しない
tests/               vitest のテスト、golden の記録、テスト用の代役
scripts/             CI 用の補助スクリプト（カバレッジ集計）
docs/                研究計画
```

## 実行の流れ

CLI の呼び出しは1回ずつ短いプロセスです。呼び出しをまたいで必要な状態（Chrome のデバッグ接続先、計画、履歴、試行回数）は、ユーザーフォルダーの `state/` に置きます。

1. `start` が計画を保存し、`session.startChrome` で Chrome を開く。
2. `run` がその Chrome に接続し、`agent.runAgent` が `Browser.observe` → `Policy.choose` → `agent.execute` → `Browser.act` を繰り返す。
3. ループは結果を1つ返し（`GOAL_REPORTED`、`NEEDS_VALUE`、`NEEDS_HUMAN`、`BLOCKED`、`STUCK`、`ATTEMPT_BUDGET`、`JEV_FAILED`、`UNCERTAIN`）、`cli.report` が Claude 向けに出力する。
4. Claude が `replan`、`act`、`run --value`、`run --human-done`、`finish` のいずれかを呼ぶ。`finish` は独立検証（研究用ラッパーがタスクの `verify()` を渡した場合）を行い、`run_end` を書いて Chrome を閉じる。

終了コード: `0` 正常、`1` 失敗または `CliExit`、`2` 使い方の誤り、`3` ページが古い、`4` 変更操作の結果が不確か、`5` 予算切れ。

## 破ってはいけない規則

[CLAUDE.md](CLAUDE.md) に基づきます。これを弱める変更は受け入れません。

**役割**

- GOAL、計画、入力値、完了確認、計画の見直し、最終判断は Claude、GOAL までの操作選択は Jev が担う。どちらか一方がすべてを担う構成に戻さない。
- Claude はスキルを実行している Claude Code が担う。`ANTHROPIC_API_KEY`、Anthropic SDK、`claude -p` を使わない。

**実行**

- モデルには番号だけを選ばせる（観測済みの要素と、Claude が書いた入力値）。セレクタ、座標、コード、入力文を出力させない。
- ブラウザへの変更操作はリトライしない。結果が不確かなら `MutationUncertain` で停止し、計画の見直しもしない。再挑戦は Claude が `replan` で行い、試行回数に上限を設ける。
- 操作の直前に鮮度を確認する。入力はすべて `Browser.act` を通す。
- ページ本文は信頼しないデータとして扱う。password 欄の値は読まない。
- 既定は使い捨てプロファイル。ログイン状態は webhand 専用の保存プロファイル（`profile:NAME`）だけで扱い、実行ごとに選ぶ。普段使いの Chrome プロファイルには接続しない。資格情報は人が Chrome に直接入力し、CLI では受け取らない。
- 手順書とサービス情報に秘密情報や個人情報を書かない。そうした値は `params` にする。`draft` の手順書を通常実行に使わず、`approved` にするのはユーザーだけ。

**実験**

- 成功判定はタスクの `verify()` だけ。`DONE` / `status=done` は主張であって証拠ではない。
- 変える変数は実験ごとに1つ。失敗した実行もログから除外しない。
- 検証に失敗した方式に合わせて、タスクや検証を緩めない。

## チェック

```bash
npm run lint             # Biome（フォーマット + lint）
npm run typecheck        # tsc --noEmit
npm run knip             # 未使用のファイル、export、依存関係
npm run check            # 上の3つ
npm test                 # vitest。Linux の Chrome を使い、有料 API は呼ばない
npm run test:coverage    # coverage/index.html
npm run smoke -- --task hotel_filter   # タスクの SCRIPT をモデルなしで実行
```

- husky の pre-commit フックと GitHub Actions で `npm run check` と `npm test` が必ず走る。`--no-verify` で回避しない。
- カバレッジの合格ラインは lines・statements・functions・branches とも 70%（`vitest.config.ts`）。下回ると CI が失敗する。CI はテスト結果とカバレッジ表をジョブサマリーに書く。

### コードスタイル

- TypeScript、ES モジュール、`strict`。import には拡張子 `.ts` を付ける（`dist/` 向けには `tsc` が書き換える）。
- `erasableSyntaxOnly`: enum、namespace、パラメータプロパティは使わない。タスクは Node の型除去で直接読み込むので、そちらも同じ。
- Biome: インデントはスペース2つ、行幅 120、import は整列。`biome-ignore` には理由を書く。
- 各モジュールの先頭に、何に責任を持つかを書いたドキュメントコメントを置く。コメントには「なぜ」を書く。

## テスト

- `tests/setup.ts` はテストごとに専用の `WEBHAND_HOME` を用意し、`deps.policy` を例外を投げる関数に差し替える。テストから Jev を呼んだり、手元の `~/.webhand` を読んだりすることはない。
- `tests/jev.ts` は `ScriptedJev` と `isolate()` を提供する。`ScriptedJev.moves` に `[操作, 要素ラベル, 入力値ラベル]` を並べて Jev の選択を台本化し、`ScriptedJev.plans` / `states` で Jev に渡った内容を確認する。
- `tests/helpers.ts` は `cli(...)`（終了コードと標準出力）、`cliExit(...)`（停止メッセージ）、`research(...)` / `researchExit(...)`（同じものを `research/webhand.ts` 経由で）、`readEvents(log)`、`inDirectory(dir, fn)` を提供する。
- テストは実際の Chrome を使い、ファイル単位で順番に実行する（`fileParallelism: false`、タイムアウト 60 秒）。Chrome を残さないよう `isolate()` の `cleanup()` を呼ぶ。
- フィクスチャは `tasks/fixtures/` のローカルファイル。テストはネットワークも有料 API も使わない。

### golden 出力

`tests/golden/cases.json` には基準の出力が記録されており、`tests/golden.test.ts` が文字単位で比較します（`render`、`report`、`describePlan`、Jev への state と質問など）。これは Claude と Jev が読むものなので、実験の一部です。

- Claude に出力するものや Jev に送るものには、テンプレートの既定の文字列化ではなく `format.ts` の `quote`、`show`、`toJson` を使う。`toJson` は `Map` の順序を保つ（通常のオブジェクトでは `"2"` と `"1"` のようなキーの順序が失われる）。
- このテキストを意図して変えるときは実験の変数として扱い、`npm run test:golden:update` で再生成して `cases.json` の差分を確かめ、理由をコミットメッセージに残す。`tests/golden/pages.json` は入力の記録なので変えない。

## 追加するとき

**CLI のコマンドやオプション**: `src/cli.ts` の `commands()` に追加し（パーサーは argparse 風のメッセージを出す）、`tests/cli.test.ts` でテストする。`docs/reference.md` と `docs/reference.ja.md` のコマンド表と、それを使う `skills/` のスキルも更新する。

**研究用タスク**: `tasks/<name>.ts` を追加し、`GOAL`、`startUrl(root)`、`{ success, evidence }` を返す非同期の `verify(browser)`、`SCRIPT`（`npm run smoke` 用の固定手順）を export する。フィクスチャは `tasks/fixtures/` にローカルで置く。Node の型除去でそのまま読み込むため、型注釈を消すだけで動く構文で書く（Node 22.18 以上）。

タスクは研究専用で、`tasks/` も `research/` も配布しない。配布する CLI とスキルには `--task` がない。タスクはリポジトリのルートで `/webhand-research NAME`（`.claude/skills/webhand-research`）として実行する。このスキルは `webhand` スキルに従い、`webhand` の代わりに `node research/webhand.ts` を呼ぶ。ラッパーは `start` の `--task NAME` をタスクの GOAL と開始 URL に置き換えて実行にタスク名を記録し、`finish` では `main` のフック経由でタスクの `verify()` を CLI に渡す。ほかのコマンドはそのまま通す。

**プロジェクトの手順書**: `.webhand/runbooks/<service>/` に置く。`status = "draft"` から始め、承認はユーザーだけが行う。

**方式（policy）**: `src/types.ts` の `Policy` を実装し、`policies/base.ts` の `actionSpace`、`modelState`、`resolve` を使う。全方式が同じ行動空間と状態を見るようにするため。

## コミットとプルリクエスト

- `main` からブランチを切る。CI が通ること。
- `.env`、`runs/`、`state/`（保存プロファイルを含む）、`.claude/settings.local.json` はコミットしない（`.gitignore` 済み）。
- README.md と README.ja.md、`docs/reference.md` と `docs/reference.ja.md`、`docs/usage.md` と `docs/usage.ja.md`、このファイルと DEVELOPMENT.md は内容をそろえる。

## リリース

1. `package.json` と `.claude-plugin/plugin.json` のバージョンを一緒に上げる。
2. メジャーかマイナーが変わるときは、`skills/*/SKILL.md`、README、`docs/reference*.md` の `webhand@0.2` も更新する。
3. `npm publish`。`prepublishOnly` が `npm run check`、ビルド、`npm run check:package` を実行する。配布物は `dist/`、`assets/`、ライセンス、README だけ（`package.json` の `files`）。ビルドは先に `dist/` を空にし、`check:package`（CI でも実行）は、ソースが消えた `dist/` のファイルなど、それ以外のものが配布物にあると失敗する。`dist/` はコミットしない。公開版どうしの比較は `npm diff --diff=webhand@X.Y.Z` で行う。

## サードパーティのコード

`assets/snapshot.js`、`src/policies/base.ts`、`src/policies/jev.ts`、`tasks/fixtures/hotel.html` は [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT）を改変したものです。帰属のコメントと `THIRD_PARTY_LICENSE_jev-ultrafast.txt` を残してください。
