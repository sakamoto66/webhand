# 一括検証の前提（Claude Code と、今後の agy 対応）

`research/batch.ts` で `tasks/` の研究タスクを一括実行するときの前提と、別のコーディングエージェントで同じ検証をするために決める項目をまとめる。使い方は [DEVELOPMENT.ja.md](../../DEVELOPMENT.ja.md)、規則の正は [AGENTS.md](../../AGENTS.md)。

2026-11-26、コミット `12d5dcf` の時点。**現在対応しているのは Claude Code だけで、agy（Antigravity CLI）では未実行・未対応。**

## 1. どのエージェントでも共通の前提

「現状」は `batch.ts`（Claude Code 向け）が満たしている度合い。

| 前提 | 現状 |
| --- | --- |
| 成功は `verify()` のみ（`DONE`・`status` は申告） | 満たす。集計は `verified === true` だけを数える |
| 1 タスク 1 新規セッション・直列 | 1 回の起動内では満たす。batch の同時起動は防がない |
| `session: new`（使い捨てプロファイル） | 起動文で指定。実際の値（ログの `run_start.session`）は batch が照合しない |
| 質問・権限確認に自動回答しない | batch は何も入力しない。ただし権限モード auto では判定器がツール呼び出しを許可・拒否し、研究スキルの `allowed-tools` は一部を事前許可する |
| 失敗も記録し、自動再試行しない | 時間切れ・起動失敗も 1 行になる。ただし batch 自体が中断された実行は行が残らず、再実行でやり直される（セッション内の再計画は webhand の試行上限に従う） |
| 変える変数は 1 つ。条件が違う回は比較しない | **強制しない**。再実行で飛ばす判定は `task`・`n`・`profile`・`model` だけで、commit や版が違っても同じ DIR の行を流用する。条件を変えたら新しい `--out` を使う |
| 直接呼び出し（`claude -p`・`codex exec`・`agy -p` など）と各社 API キー・SDK を使わない | 満たす。対話の CLI を端末で起動する |
| ユーザー環境の差を持ち込まない（指示ファイル・hook・プラグイン・ユーザースキル・自動メモリ・MCP を読み込まず、`AGENTS.md` は読む） | **一部**。管理設定、ログイン、リポジトリより上のフォルダの `CLAUDE.md` / `AGENTS.md`、ペインが引き継ぐ環境変数（`TYPESAFE_MODEL`・`WEBHAND_*` など）、端末の Chrome は残る。リポジトリ内の設定（プロジェクトの設定・スキル、`.webhand/runbooks`）は条件の一部で、読まれる |
| 項目を記録する | **一部**。下の表 |
| タスクのソースを読ませない | **指示のみ**。研究スキルが `tasks/` を開くな・一覧するなと書くが、機械的な拒否は batch にもリポジトリの設定にも見当たらず、読んだかの検査もない |

### 記録する項目

`DIR/results.jsonl` の 1 行と、行の `log` が指す実行ログに分かれる。

| 項目 | 場所と注意 |
| --- | --- |
| 結果 | `verified`、`attempts`（`run_end` がなければ null） |
| 時間 | `duration_ms`。タブ作成から、`run_end` 後の応答待ち（最大 60 秒）の終わりまで。5 秒間隔の確認 |
| ホストのトークン | `tokens`（input・output・cache 作成・cache 読込）。取れなければ null。Jev の分は実行ログの `run_end.providers` |
| 構成・モデル | `profile`（lean / full）、`model`。`model` は `--model` の指定値で、実際に応答したモデルではない |
| commit | `commit`（HEAD）。未コミット変更の有無は行になく、ログの `run_start.git.dirty` |
| 版 | `claude_version` と `batch_node_version` は **batch プロセス側**の値。ペイン内の `claude`・Node と同じとは限らない。Chrome の版は行になく、ログの `run_start.chrome` |
| Jev のモデル | 行になく、ログの `call` の `model`（応答にあればその値）。既定の指定は `jev-latest` で固定されない |
| 終了理由 | `end_reason`（`run_end`・`needs_input`・`timeout`・`herdr_error`・`launch_failed`）、`error` |
| 停止の有無 | `blocked`。5 秒間隔で herdr の状態を見るため、短い停止は漏れ得る |

起動前に失敗した行や `run_end` がない行は `log` が null で、ログ側の項目は取れないことがある。

## 2. Claude Code での実現方法

確認の欄: **試走** = CC 2.1.332・Claude Sonnet 5.5 の `hotel_filter`。1 回の試走は lean と full 各 1 実行で、`5ed9b5a`・`825cf59`・`12d5dcf` の 3 回（条件が違い、回の間は比較できない）。**静的** = CC 2.1.332 の実体を読んだ確認。**コード** = `batch.ts` が渡していることだけ（テストは偽の herdr）。

| 目的 | 指定・方法 | 確認 |
| --- | --- | --- |
| ユーザー・ローカル設定を外す（設定の env・hook・権限、プラグイン、ユーザー／同期スキル） | `--setting-sources project` | 静的。試走でスキル一覧にユーザー・同期・プラグイン由来がないことを確認。同期プラグインのダウンロード済み分は未確認 |
| 権限モードを固定 | `--permission-mode auto` | 試走。auto 非対応モデルは未確認 |
| ユーザーの指示ファイルを外す | `--settings` の `claudeMdExcludes`（`~/.claude/**`） | 静的 + 試走（読み込んだ指示は `AGENTS.md` のみ） |
| MCP を外す | `--strict-mcp-config`（`--mcp-config` は渡さない） | コード |
| 自動メモリを切る | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（`env` コマンドと `--settings` の `env` の両方） | コード |
| 軽量構成（lean、既定） | `--tools Bash,Read,AskUserQuestion,Skill` と `disableBundledSkills`。`--full` は両方とも付けない | 試走（スキル一覧は lean 8 件、full 26 件） |
| 作業後の auto mode 設定の質問を出さない | `skillOverrides: {"auto-mode-setup": "off"}` | 静的 + 試走（12d5dcf で表示なし）。サーバー側の条件変化は否定できない |
| 研究スキルの起動 | 起動文 `/webhand-research NAME (session: new)`。`.claude/skills/` は `.agents/skills/` へのシンボリックリンク | 試走 |
| 実行ごとの状態の分離（ログ、サイト記憶、ユーザー手順書） | `WEBHAND_HOME` を `DIR/homes/` の実行専用フォルダにする | コード |
| セッションの特定とトークン | `--session-id` に UUID。`$CLAUDE_CONFIG_DIR`（既定 `~/.claude`）の `projects/*/ID.jsonl` と `ID/subagents/` の usage を message ID ごとに 1 回数える | 試走（値を記録） |
| 起動・状態・終了 | herdr の `tab create`（リポジトリを cwd）、`pane run`、`pane get` の `agent_status`、`pane close`（自分のペインだけ）。終了はログの `run_end`、上限 20 分 | 試走（hook なしで `working`・`blocked` を検出） |
| 版の取得 | `claude --version`、`process.version` | 試走 |
| 認証と Jev のキー | 端末のログインと、ペインの `TYPESAFE_API_KEY` を使う | 試走 |

`--out` はリポジトリ外か git の無視対象でなければ拒否する。

## 3. agy 対応で決める・確かめる項目

リポジトリ内で確認できる事実（agy で動かして確かめたものではない）:

- `.antigravity-plugin/plugin.json`: プラグインのマニフェスト（名前・版・説明など）。
- `hooks.json`（ルート）と `hooks/ask-allow-control.mjs`: `run_command` の PreToolUse で、`--allow-control` を含む webhand コマンドに `force_ask` を返す（`tests/hook.test.ts` は入力を模した単体テスト）。
- `.agents/skills/webhand-research/SKILL.md` などの研究スキル本体。frontmatter の `argument-hint`・`allowed-tools` と本文の `AskUserQuestion` が agy でどう扱われるかは未確認。
- `DEVELOPMENT.ja.md`: `agy plugin validate .` と `agy plugin install .` の手順。`--strict` の想定内警告として、ルートの `AGENTS.md`（開発者向け規則）と `hooks/hooks.json`（Claude Code 用）が挙がる。

| 前提 | agy で相当する手段（すべて未確認） |
| --- | --- |
| 起動と指示の渡し方 | 対話セッションを起動文つきで始める方法（`agy -p` は使わない）、モデルの指定 |
| スキルの配置と呼び出し | `.agents/skills/` を読むか、呼び出しの書式、プラグイン導入が要るか（導入するとユーザー環境が変わる） |
| `AGENTS.md` を読む | 読み込まれるか |
| 設定の分離 | ユーザーの指示ファイル・hook・プラグイン・スキル・自動メモリ・MCP を外す指定。ルート `hooks.json` がプラグイン未導入で効くか |
| 権限モード | 固定の指定、確認の出方、研究コマンドの事前許可 |
| ツール限定 | lean 相当の指定。できなければ構成を分けるか |
| タスクのソースを読ませない | 読み取りを拒否する指定があるか |
| セッション ID とトークン | ID の指定か取得、使用量の記録場所と区分（Claude と区分が違えば比較しない） |
| 状態検出と終了 | herdr の `agent_status` が使えるか、質問・権限待ちの判定、初回ダイアログ |
| 版の取得 | 版コマンド、ペイン内の版との一致 |

エージェントが違う結果は条件が複数違うので、Claude Code の回と 1 変数の比較にはしない。

## 4. 未確認点（Claude Code）

- main の checkout からの実行（試走は worktree）。
- 実セッションでの時間切れと、質問・権限確認での停止。
- 実セッションでの複数タスク・複数回の連続実行。
- 他の端末（初回通知、同期プラグイン、上位フォルダの指示ファイル）。
- 時間切れ後に残る Chrome と、batch を Ctrl-C で止めたあとのペイン（どちらも後始末は未実装）。
