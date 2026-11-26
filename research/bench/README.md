# webhand を BU Bench V2.1 で採点する

一般ユーザーと同じ使い方（Claude Code の `/webhand` スキル）でタスクをこなし、その記録を browser-use/benchmark の findings judge で採点します。webhand リポジトリの `tasks/` も `--task` も使いません。

得点は「Claude Code + webhand」の成績です。`verify()` による成功とは呼ばず、別の指標として扱います（webhand の AGENTS.md）。公式のリーダーボード（BrowserCode）とは、実行環境と証拠のまとめ方が違うため、厳密には比べられません。

このフォルダーは研究用で、npm の配布物には含めません。

## 公開しないもの

このリポジトリは公開されています。次のものはデータの置き場所にだけ置き、コミットも公開もしません: 復号したタスク文、ページの内容、ルーブリック、judge の出力、実行の記録、分析の結果、タスクから作った手順書。サイト名とタスクの内容を結びつける記述も、ここのファイルに書きません。

## 置き場所

コードはこのフォルダー（`research/bench/`）、データはリポジトリの外（既定 `~/webhand-bench`、`WEBHAND_BENCH` で変更）です。

コード:

| パス | 中身 |
| --- | --- |
| `setup.sh` | benchmark を固定した版で取得して入れる |
| `scripts/` | 準備、監視、確認、収集、採点、集計 |
| `run_all.sh`、`worker.sh`、`next.sh` | 評価セッションの起動 |
| `diagnose.sh`、`run_analysis.sh`、`analysis_status.sh` | 2つの回の診断 |
| `eval-settings.json`、`eval-settings-lean.json` | 評価セッションの設定のひな形（`BENCH_PROFILE` で選ぶ。`@CODE@` はこのフォルダー） |
| `analysis/` | 分析セッションのプロンプトとテンプレート（手順は `ANALYSIS.md`） |
| `picks/picks-<シード>.txt` | 選んだタスクの ID |

データ:

| パス | 中身 |
| --- | --- |
| `benchmark/` | browser-use/benchmark の `v2.1.1` |
| `work/<ID>/` | 評価セッション1回分。`prompt.txt`（指示文だけ）、`launch.sh`、`eval-settings.json`、`meta.json`、`outputs/`（成果物）、`home/`（`WEBHAND_HOME`。ログとスクリーンショット） |
| `results/<ID>/` | `trace.json`、`judge/`（ルーブリックを引用する）、`result.json`（数値だけ） |
| `work-<回>/`、`results-<回>/` | `BENCH_ROUND=<回>` の回 |
| `analysis/` | 分析の結果（`ANALYSIS.md`） |
| `STOP`、`.score.lock` | 実行中の制御 |

日付つきの条件の記録と回の結果は、タスクの内容に触れるため、データ側（`~/webhand-bench/README.md`）に書きます。

## 準備（最初の1回）

```sh
research/bench/setup.sh
```

ほかに必要なもの:

- `webhand` コマンド: webhand リポジトリで `npm run build && npm link` を実行し、そのあと `chmod +x dist/bin.js`
- 条件ごとに CLI を選ぶ（`BENCH_CLI_REPO`）には、`webhand` コマンドを振り分けスクリプトにする（下の「条件」）
- webhand プラグイン（`claude plugin list` で確認）
- 環境変数 `TYPESAFE_API_KEY`（Jev）と `OPENAI_API_KEY`（judge、有料）
- 並列で回すときと診断には herdr

準備と起動は、回が終わるまで内容の変わらないチェックアウト（専用の worktree）から行います。`launch.sh` と `eval-settings.json` は、準備したときのこのフォルダーの絶対パスを指すので、途中でブランチを切り替えると条件が変わります。`prepare.py` は、このフォルダーに未コミットの変更があると断り、`meta.json` に `harness_repo` と `harness_commit` を残します。

以下のコマンドでは、`B` と `R` を次の意味で使います。

```sh
R=/path/to/webhand/research/bench
B="uv run --project $HOME/webhand-bench/benchmark python $R/scripts"
```

## 手順

1. 対象のタスクを、中身を見ずに決めます（シードを先に決めて記録しておく）。広げるときは `--exclude-prepared` で済んだタスクを除き、新しいシードで選びます。選んだ結果は `picks/picks-<シード>.txt` に残します。

   ```sh
   $B/pick.py 5 --seed 20261104
   $B/pick.py 15 --seed 20261105 --exclude-prepared
   ```

2. タスクごとに準備します。同じタスクの2回目の準備は断ります（1タスク1回。失敗した回も残します）。

   ```sh
   $B/prepare.py bu2-XXX
   ```

3. **新しいターミナル**で `~/webhand-bench/work/bu2-XXX/launch.sh` を実行します。まだ起動していないタスクを ID の順に1つ起動するなら、`$R/next.sh` でも同じです。

   まとめて回すなら `$R/run_all.sh [N]` を使います（下の「まとめて回す」）。

4. 下の「実行中の決まり」に従って見守り、終わったら `/exit` で閉じます。
5. 記録を集め、採点します。

   ```sh
   $B/collect.py bu2-XXX
   $B/score.py bu2-XXX
   $B/summary.py
   ```

   起動済みで採点していないタスクをまとめて処理するなら、`$B/score_pending.py` を使います。

   同じタスクを別の条件で回し直すときは、どのコマンドにも `BENCH_ROUND=名前` を付けます。2つの回は `$B/compare.py 名前 --base 基準の回 --picks picks-<シード>.txt` で、タスクごとに対で比べます。

6. 失敗の理由を調べるときは、`ANALYSIS.md` の手順に従い、別のセッションで行います。

## 条件（`prepare.py` に渡す環境変数）

実験ごとに変えるのは1つです。値は `meta.json` に残ります。

| 変数 | 意味 |
| --- | --- |
| `BENCH_ROUND` | 回の名前。ほかのコマンドにも付ける |
| `BENCH_MODEL` | Claude のモデル（既定 `claude-sonnet-5-5`） |
| `BENCH_PROFILE` | `full`（既定。これまでの回と同じ）か `lean`（下の「軽量化」） |
| `BENCH_FLOW` | webhand の流れ `v1`（既定）か `v2` |
| `BENCH_SKILL_REPO` | スキルをこの webhand リポジトリから `--plugin-dir` で読む（未指定はインストール済みのプラグイン） |
| `BENCH_CLI_REPO` | この webhand チェックアウトの CLI を使う（ビルド済みで、ソースに未コミットの変更がないもの） |
| `BENCH_ENGINE` | `WEBHAND_ENGINE` を指定する |
| `BENCH_KNOWLEDGE_FROM` | 指定した回の同じタスクの知識を、起動時にコピーする |
| `BENCH_KNOWLEDGE_USE` | `0` で知識を Jev に渡さない（記録は続ける） |
| `BENCH_RUNBOOKS_FROM` | `DIR/<ID>/` の手順書を、そのタスクの `WEBHAND_HOME/runbooks` へコピーする |

`BENCH_CLI_REPO` は `launch.sh` の `WEBHAND_CLI_REPO` になります。これを読むには、`PATH` の `webhand` を、次の動きをする振り分けスクリプトにします（端末ごとの導入物なので、リポジトリには置きません）: `WEBHAND_CLI_REPO` があればそのチェックアウトの、なければ既定のチェックアウトの `dist/bin.js` を実行し、指定があるときは呼び出しごとにチェックアウトのパスを `$WEBHAND_HOME/cli_used.log` に追記する。

### 軽量化（`BENCH_PROFILE=lean`）

セッションの開始時に読み込むものを減らします。`full` との違いは次のとおりです。

- `launch.sh` で `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（自動メモリなし）。
- `--tools` で組み込みツールを `Bash,Read,Write,Edit,AskUserQuestion,Skill,ToolSearch,WebFetch,WebSearch,Monitor,TaskStop` に限る。
- `eval-settings-lean.json`: 組み込みスキルを無効にし、タスクに使わないプラグインとスキルを切る。フックは同じ。webhand プラグインは切りません。
- `skillOverrides` は名前の完全一致だけです（Claude Code 2.1.332 の実装で確認。`anthropic-skills:*` のような指定は効きません）。同期スキルが増えたら、このファイルに足します。切るプラグインとスキルの名前は端末の構成に依存します。

減る量と、次の点は実際のセッションでは未確認です。使う前に1件の試走で確かめます: 開始時のトークン、webhand スキルの読み込みと `check_*.py`、`ToolSearch` からの `WebFetch`・`WebSearch`、自動回答のフック、同期スキルへの `skillOverrides`。

## まとめて回す

`$R/run_all.sh [N]`（既定 3。`BENCH_PARALLEL` でも指定）は、準備済みで未開始のタスクを順に起動し、終わるたびに採点します。人がするのは、質問と権限の確認に答えることだけです。

- N>1 は herdr のワークスペース `bench-<回>` に N ペインを作り、各ペインで `worker.sh` が `work-<回>/<ID>/.claim` を取り合ってタスクを1つずつ実行します。N=1 はこの端末で直列に実行します（端末なしのバックグラウンドでは起動しないでください）。メモリは1セッション約0.7 GB です。
- `BENCH_ROUNDS="a b"` は、2つの回をタスクごとに交互に回します。
- セッションは、Claude が発言を終えてから3分間（`BENCH_IDLE_S`。`webhand finish` の報告のあとは30秒、`BENCH_DONE_S`）何も起きなければ閉じます。60分（`BENCH_TIME_LIMIT_S`）たったときと、モデルの応答を10分（`BENCH_STALL_S`）待ったまま何も書かれないときも閉じます。閉じた理由は `work/<ID>/ended_by` に残ります（`idle-after-turn`、`time-limit`、`stalled`、`person`）。`stalled` の回も残して採点し、`summary.py` で分けて表示します。
- 質問や権限の確認が出ている間は閉じません。
- タスクごとに、スキル、モデル、Jev、CLI、流れを確かめ、違えば `STOP` を作って全ワーカーを止めます。Jev がアカウントの理由で断ったタスクには `invalid` の印を付け、採点しません。
- 今のタスクのあとで止めるには、`touch ~/webhand-bench/STOP` を実行します。
- 答えが要りそうなときはビープ音が鳴ります。フックは音を鳴らすか、決まった答えを返すだけです。
- 評価セッションは `--strict-mcp-config` で起動し、`/webhand:webhand` に指示文を渡します。作業フォルダーがタスクごとに別なので、自動メモリ（`full` のとき）もタスクごとに分かれます。作業フォルダーには、会話を日本語にする `CLAUDE.md` を置きます。

## 実行中の決まり

人は手伝いません。benchmark は人の介入を前提にしていないためです。

- 権限の確認は、内容を変えずに許可します。
- スキルがセッションの種類を聞いたら、`new` を選びます。
- `AskUserQuestion` には、フック（`scripts/auto_answer.py`）が選択肢を選ばずに決まった文で答え、`WEBHAND_HOME/auto_answers.jsonl` に記録します。
- 文章での質問（値の入力、確認）には、3分以内に「お答えできません。手元の情報だけで進めてください。」と答えます。
- CAPTCHA やログインには対応しません。「対応できません。手元の情報だけで進めてください。」と答えます。
- 指示や助言を書きません。書いた内容は `user:` として trace に入り、judge に見えます。
- 60分で打ち切ります。手で閉じるときは `/exit` で閉じ、そのまま collect と score に進みます（`run_all.sh` では自動です。時間切れのときは、BrowserCode の実行と同じ注記を trace に入れます）。
- 評価セッションに `results/`、`benchmark/`、ほかのタスクの `work/` を開かせません。

## 診断

`BENCH_ROUNDS="A B"` の両方の回の採点が終わると、最後のワーカーが `diagnose.sh A B` を起動します（`BENCH_DIAGNOSE=0` で止める。やり直すには `analysis/auto/A-B.started` を消す）。

- `analysis/auto/A-B/report.txt`: 数値だけのレポート。
- herdr のワークスペース `diag-A-B`: 分析セッション2つ。2つの回の `work-*`・`results-*` を読み、出力の1ファイルだけを書きます。**分析ファイルは人が先に読みます**（`ANALYSIS.md`）。
- 状態の確認と後片付けは `$R/analysis_status.sh A B [--close]`。

## 採点の中身

- `collect.py`: Claude Code のトランスクリプト（`~/.claude/projects/<作業フォルダー>/`）から、文章、ツール呼び出しとその結果、最終回答を BrowserCode の trace と同じ形にします。スクリーンショットは webhand が操作のたびに撮ったもので、ファイルの更新時刻から、そのとき実行中だった webhand コマンドの手順に割り当てます。成果物は benchmark 自身の `collect_outputs` で読みます。エージェントが自分で見た画像は添付しません。
- `score.py`: benchmark の `judge_trace`（findings judge）に渡し、重みをもとにコードで得点を出します。表示するのは数値だけです。同じタスクを採点し直すには `--again` を付けます（前の結果は残ります）。
- `summary.py`: 準備したタスクをすべて数えます。採点していないタスクは、除かずに「unscored」と表示します。分類器や権限で拒否された回数も表示します。
