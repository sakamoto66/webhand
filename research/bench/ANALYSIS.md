# 失敗の理由を調べる（別のセッションで）

`~/webhand-bench` はデータの置き場所（`WEBHAND_BENCH` で変えたときは読み替える）、`REPO` は webhand リポジトリのチェックアウトです。分析の結果（`~/webhand-bench/analysis/` に書かれるもの）はコミットしません。

judge の出力（`results/<ID>/judge/judge_response.json`）は、ルーブリックとタスクの中身を引用しています。読むのは、**評価にも webhand の改善にも使わない Claude Code のセッション**にしてください。webhand を改善するセッションが読むと、特定のタスクに合わせた調整になり、評価の意味がなくなります。

改善するセッションに持ち込んでよいのは、タスクに依存しない一般的な失敗の型（たとえば「`blocked` のあと新しい実行を始めずに終えた」「必要な証拠を集めずに値を書いた」）と、その件数だけです。

## 手順

1. 新しいターミナルで次を実行します。

   ```sh
   mkdir -p ~/webhand-bench/analysis && cd ~/webhand-bench/analysis && claude --strict-mcp-config
   ```

2. 下のプロンプトを貼り付けます。
3. できた `~/webhand-bench/analysis/failure-modes.md` を、ご自身で読みます。タスク固有の内容が入っていないことを確かめてから、改善のセッションに渡してください。

## プロンプト

```text
~/webhand-bench/results/*/judge/judge_response.json と ~/webhand-bench/results/*/result.json を読み、
webhand（Claude が計画し、Jev がブラウザを操作するエージェント）の失敗の型をまとめてください。

- violated と判定された項目ごとに、evidence から「エージェントが何をしなかった／間違えたか」を、
  タスクに依存しない一般的な型に分類してください（例: 必要なページを開かずに終えた、値を記憶から書いた、
  成果物の形式が違う、ブロックで止まり回復しなかった、途中で打ち切った）。
- 型ごとに件数と、該当するタスク ID だけを書いてください。
- タスク文、ルーブリック、サイト名、具体的な値、evidence の文面は書かないでください。
- 結果は ~/webhand-bench/analysis/failure-modes.md に日本語で書いてください。ほかのファイルは作らないでください。
- benchmark/ のファイルや .enc は開かないでください。
```

## 一覧から選ぶ場面の調べ方（回 `compare`、2026-11-07）

回 `compare` では、`--compare`（操作の前に一覧全体をスクロールして比べる）が20件のどれでも使われませんでした。使う場面がなかったのか、場面はあったのに使われなかったのかを調べます。手順は上と同じで、プロンプトだけを次のものに替えます。結果は `~/webhand-bench/analysis/list-choices.md` に入ります。

```text
~/webhand-bench/results-compare/*/trace.json、~/webhand-bench/results-compare/*/judge/judge_response.json、
~/webhand-bench/results-compare/*/result.json と、~/webhand-bench/work-compare/*/home/runs/*/*.jsonl を読み、
次のことを調べてください。webhand は Claude が計画し、Jev がブラウザを操作するエージェントです。webhand の
`--compare CRITERION` は、操作の前に webhand がページを上から下まで1画面ずつスクロールし、条件に一番合う項目を
Jev に比べさせる仕組みです（ログでは compare_round、compare_end）。この回では一度も使われていません。

1. タスクごとに、「1画面に収まらない一覧（検索結果、商品、プラン、表の行など）から、条件（一番安い、評価が一番高い、
   一番新しい、条件に合うものすべて、など）で項目を選ぶ、または比べる」場面があったかを判定してください。
2. 場面があったタスクごとに、次を分類してください。
   - エージェントがどう選んだか: サイトの並べ替えや絞り込み / サイト内検索 / 読み取り層（--read）で読んだ / 
     スクロールしながら見た / 最初に見えた分だけで選んだ / 選ばずに終えた / その他
   - 一覧の形: ページ全体のスクロール / ページの中の別のスクロール枠 / 「もっと見る」ボタン / ページ送り / 
     スクロールで読み込まれる / わからない
   - 選んだ結果について、judge が関係する項目を met と判定したか、violated と判定したか
3. 型ごとに件数と、該当するタスク ID だけを書いてください。

- タスク文、ルーブリック、サイト名、URL、具体的な値、evidence の文面、ページの文章は書かないでください。
- 結果は ~/webhand-bench/analysis/list-choices.md に日本語で書いてください。ほかのファイルは作らないでください。
- benchmark/ のファイルや .enc は開かないでください。
```

## `--collect` が読めなかった一覧の調べ方（回 `more`、2026-11-07）

回 `more` では、`--collect` が7件で13回使われました。読めた項目が0件の回が7回、読めたのに条件に合うものが0件の回が5回、合うものがあった回が1回です。`--more` は9回とも、押す要素がない（`NONE`）という答えでした。どこで読めなかったのかを、型と件数で調べます。手順は上と同じで、プロンプトだけを次のものに替えます。結果は `~/webhand-bench/analysis/collect-shapes.md` に入ります。

```text
~/webhand-bench/work-more/*/home/runs/*/*.jsonl、~/webhand-bench/results-more/*/trace.json、
~/webhand-bench/results-more/*/judge/judge_response.json、~/webhand-bench/results-more/*/result.json を読み、
次のことを調べてください。webhand は Claude が計画し、Jev がブラウザを操作するエージェントです。

webhand の `--collect CONDITION` は、ページ全体（window）を上から1画面ずつスクロールし、画面内の
tr、li、[role=row]、[role=listitem]、article のうち一番内側の要素の文章を「項目」として読み、
1件ずつ条件に合うかを Jev に聞きます。ログでは collect_round（rows: 画面内で読めた数、new: 新しく読めた数、
matched: 合った数、y と height: ページ全体のスクロール位置と高さ）と collect_end です。
`--more CONTROL` は、一覧の下まで来たとき、画面内の押せる要素から Claude が名前を書いた操作（「もっと見る」
「次のページ」など）を Jev に選ばせます。ログでは more（pressed が null なら押していない）です。

collect_end がある実行ごとに（13回）、次を判定してください。
1. collect を始めたとき、目的の一覧が表示されていたか: 表示されていた / 一覧の前のページだった
   （ブロック、ログイン、検索前など） / わからない
2. 目的の一覧の項目は、どの要素で組まれていたか: tr / li / [role=row] などの role / article /
   それ以外（div など） / わからない
3. 目的の一覧は、どこでスクロールしたか: ページ全体 / ページの中の別のスクロール枠 / スクロールしない
   （全件が1画面に収まる） / わからない
4. rows が1以上の回: 読めた項目は目的の一覧の項目だったか: 一覧の項目 / 一覧以外（メニュー、フッター、
   絞り込みの選択肢など） / 両方 / わからない
5. matched が0の回: 一覧に条件に合う項目は本当になかったか: なかった / あったのに NO と判定された /
   わからない
6. 一覧に「もっと見る」ボタンやページ送りがあったか、あった場合 more が聞かれた時点で画面内にあったか
7. その実行のあと Claude がどうしたか: 集めた結果を使った / 別の方法（自分でスクロール、サイト内検索、
   読み取り層など）に切り替えた / そのまま終えた

必要なら、ログにある URL を自分のブラウザで開いて、ページの要素の組み方を確かめてかまいません
（Playwright などの一時スクリプトは /tmp に置き、終わったら消してください）。ログインやフォームの送信はしないでください。
ボット対策でページを開けないときは、回避しないでください。

型ごとに件数と、該当するタスク ID（と実行のフォルダー名）だけを書いてください。
- タスク文、ルーブリック、サイト名、URL、具体的な値、evidence の文面、ページの文章は書かないでください。
  要素の名前（div、li、role など）とスクロールの仕組みは書いてかまいません。
- 結果は ~/webhand-bench/analysis/collect-shapes.md に日本語で書いてください。ほかのファイルは作らないでください。
- benchmark/ のファイルや .enc は開かないでください。
```

## `--collect` の合うものが0件だった理由の調べ方（回 `items`、2026-11-08）

回 `items` では、`--collect` が8件で12回使われました。項目が読めたのに合うものが0件だった回が7回、合うものがあった回が1回です。`--more` は11回とも、押す要素がない（`NONE`）という答えでした。合うものが0件だった理由と、続きの操作が押されなかった理由を、型と件数で調べます。手順は上と同じで、プロンプトだけを次のものに替えます。結果は `~/webhand-bench/analysis/collect-zero.md` に入ります。

```text
~/webhand-bench/work-items/*/home/runs/*/*.jsonl、~/webhand-bench/results-items/*/trace.json、
~/webhand-bench/results-items/*/judge/judge_response.json、~/webhand-bench/results-items/*/result.json を読み、
次のことを調べてください。webhand は Claude が計画し、Jev がブラウザを操作するエージェントです。

webhand の `--collect CONDITION` は、ページ全体を上から1画面ずつスクロールし、画面内の一覧の項目
（表の行と、同じタグとクラスで3つ以上並んだまとまり。メニュー、ヘッダー、フッターの中は除き、入れ子は外側）
の文章を読み、1件ずつ条件に合うか（MATCH / NO）を Jev に聞きます。ログでは collect_round（rows: 画面内で
読めた数、new: 新しく読めた数、matched: 合った数、y と height: スクロール位置とページの高さ）と collect_end
（seen: 読めた項目の合計、matched: 合った数）です。CONDITION は plan イベントの collect にあります。
`--more CONTROL` は、一覧の最後の項目が画面に入ったところと一番下で、画面内の押せる要素から Claude が
名前を書いた操作を Jev に選ばせます。ログでは more（pressed が null なら押していない）です。

collect_end がある回ごとに、次を判定してください。
1. 読めた項目（seen）は、目的の一覧の項目だったか: 一覧の項目 / 一覧以外（ほかの一覧、絞り込みの選択肢、
   メニューなど） / 両方 / 読めた項目が0件 / わからない
2. 一覧の項目だった場合、1項目として読めた範囲: 1件ずつ / 何件かがまとまって1項目 / 1件の一部だけ / わからない
3. matched が0の回: 一覧に条件に合う項目は本当になかったか: なかった / あったのに NO と判定された /
   あったが読まれなかった / 一覧が出ていなかった / わからない
4. CONDITION の書き方: 項目の文章だけで判定できる / 項目の文章にない情報が要る（詳細ページの中身など） /
   ページ全体の状態が要る（絞り込みの結果か、など） / わからない
5. 一覧の続き（「もっと見る」ボタン、ページ送り、スクロールで読み込まれる）があったか。あった場合、
   more が聞かれた時点で、その操作が画面内にあったか / 画面外だったか / more が聞かれていないか
6. その回のあと Claude がどうしたか: 集めた結果を使った / 別の方法に切り替えた / 集め直した / そのまま終えた

必要なら、ログにある URL を自分のブラウザで開いて、ページの要素の組み方を確かめてかまいません
（Playwright などの一時スクリプトは /tmp に置き、終わったら消してください）。ログインやフォームの送信はしないでください。
ボット対策でページを開けないときは、回避しないでください。

型ごとに件数と、該当するタスク ID（と実行のフォルダー名）だけを書いてください。
- タスク文、ルーブリック、サイト名、URL、具体的な値、evidence の文面、ページの文章、CONDITION の文面は書かないでください。
  要素の名前（div、li、role など）とスクロールの仕組みは書いてかまいません。
- 結果は ~/webhand-bench/analysis/collect-zero.md に日本語で書いてください。ほかのファイルは作らないでください。
- benchmark/ のファイルや .enc は開かないでください。
```

## 頼まれた作業が終わったかの調べ方（回 `aa`、`aa2`、2026-11-09）

得点ではなく、Claude が計画して手順を実行したあと、頼まれた作業が終わったかを数えます。集めた値が正しいかは、ここでは扱いません（別の問題として、学習データに積み上げる側で扱います）。回 `aa` と `aa2` は同じ条件（webhand `7f07630`、Sonnet 5.5）なので、同じ20件の40セッションを対象にします。手順は上と同じで、プロンプトだけを次のものに替えます。結果は `~/webhand-bench/analysis/completion.md` に入ります。

```text
~/webhand-bench/results-aa/* と ~/webhand-bench/results-aa2/* の trace.json、judge/judge_response.json、result.json と、
~/webhand-bench/work-aa/*/home/runs/*/*.jsonl、~/webhand-bench/work-aa2/*/home/runs/*/*.jsonl、
~/webhand-bench/work-aa/*/outputs/、~/webhand-bench/work-aa2/*/outputs/ を読み、次のことを調べてください。
webhand は、Claude が計画し、Jev がブラウザを操作するエージェントです。2つの回は同じ条件で、同じ20タスクを回しています。

ここで数えたいのは「頼まれた作業が終わったか」です。値や内容が正しいかは数えません。たとえば、頼まれた
ページで頼まれた操作（検索、絞り込み、一覧の読み取り、フォームの入力など）を最後までやり、頼まれた形の
成果物や答えを出していれば、値が間違っていても「終わった」とします。

セッション（タスク × 回）ごとに、次を判定してください。
1. 作業が終わったか: 終わった / 一部だけ終わった / 終わらなかった
2. 終わらなかった、または一部だけのとき、どこで止まったか（主なものを1つ）:
   - 目的のページに着けなかった（ボット確認、ログイン、地域制限、エラーページ、ページが見つからない）
   - ページには着いたが、必要な操作ができなかった（要素が見つからない、押しても変わらない、入力できない）
   - 一覧や結果の一部しか読めなかった（ページ送り、もっと見る、スクロール、iframe など）
   - webhand の試行の上限や時間切れで止まった
   - Claude が途中であきらめた、または代わりの方法を試さずに終えた
   - Claude が終わったと判断したが、頼まれたことの一部をしていなかった
   - 成果物を作らなかった、または頼まれた形でなかった
   - その他
3. 最後の webhand の結果（ログの escalation の reason、run_end、finish の status）
4. 止まったあと、Claude が別の方法（別のページ、検索、別の手順、replan）を試したか: 試した / 試さなかった
5. 同じタスクで、2つの回の判定（1）が同じだったか

型ごとに件数と、該当するタスク ID と回の名前だけを書いてください。最後に、タスクごとの判定を
「タスク ID / aa / aa2」の表にしてください。
- タスク文、ルーブリック、サイト名、URL、具体的な値、evidence の文面、ページの文章は書かないでください。
- 結果は ~/webhand-bench/analysis/completion.md に日本語で書いてください。ほかのファイルは作らないでください。
- benchmark/ のファイルや .enc は開かないでください。
```

## v1 と v2 で、頼まれた作業が終わったかの調べ方（回 `fv1`・`fv2`・`fv1b`・`fv2b`、2026-11-13）

上の「頼まれた作業が終わったかの調べ方」と同じ判定を、webhand の流れだけが違う20組の40セッションで行います。条件は webhand `84bfb1b`、Sonnet 5.5 です。v1 は今までの流れ、v2 はページ全体の操作と自動スクロール、対象に絞った鮮度の確認、ページの状態を足した流れです。手順は上と同じで、プロンプトだけを次のものに替えます。結果は `~/webhand-bench/analysis/completion-fv.md` に入ります。

```text
次の40セッションを対象にします。webhand は、Claude が計画し、Jev がブラウザを操作するエージェントです。
- v1: ~/webhand-bench/work-fv1/ と results-fv1/ の bu2-012、bu2-021、bu2-024、bu2-025、bu2-173 と、
  ~/webhand-bench/work-fv1b/* と results-fv1b/* の15件
- v2: ~/webhand-bench/work-fv2/ と results-fv2/ の同じ5件と、~/webhand-bench/work-fv2b/* と results-fv2b/* の15件
work-fv1/ と work-fv2/ のほかのタスク（invalid というファイルがあるもの）は、Jev が動かなかった回なので読まないでください。
各セッションの trace.json、judge/judge_response.json、result.json、work-*/<ID>/home/runs/*/*.jsonl、
work-*/<ID>/outputs/ を読み、次のことを調べてください。

ここで数えたいのは「頼まれた作業が終わったか」です。値や内容が正しいかは数えません。たとえば、頼まれた
ページで頼まれた操作（検索、絞り込み、一覧の読み取り、フォームの入力など）を最後までやり、頼まれた形の
成果物や答えを出していれば、値が間違っていても「終わった」とします。

セッション（タスク × v1/v2）ごとに、次を判定してください。
1. 作業が終わったか: 終わった / 一部だけ終わった / 終わらなかった
2. 終わらなかった、または一部だけのとき、どこで止まったか（主なものを1つ）:
   - 目的のページに着けなかった（ボット確認、ログイン、地域制限、エラーページ、ページが見つからない）
   - ページには着いたが、必要な操作ができなかった（要素が見つからない、押しても変わらない、入力できない）
   - 一覧や結果の一部しか読めなかった（ページ送り、もっと見る、スクロール、iframe など）
   - webhand の試行の上限や時間切れで止まった
   - Jev が呼び出しを断った（ログの escalation の reason が JEV_FAILED）
   - Claude が途中であきらめた、または代わりの方法を試さずに終えた
   - Claude が終わったと判断したが、頼まれたことの一部をしていなかった
   - 成果物を作らなかった、または頼まれた形でなかった
   - その他
3. 最後の webhand の結果（ログの escalation の reason、run_end、finish の status）
4. 止まったあと、Claude が別の方法（別のページ、検索、別の手順、replan、act での手作業）を試したか: 試した / 試さなかった
5. 同じタスクで、v1 と v2 の判定（1）が同じだったか。違ったときは、その違いが webhand のどの動き
   （画面外の要素の自動スクロール、鮮度の確認、ページの状態、Jev の断り、その他）から来たかを、型だけで書く

型ごとに件数と、該当するタスク ID と v1/v2 だけを書いてください。最後に、タスクごとの判定を
「タスク ID / v1 / v2」の表にしてください。
- タスク文、ルーブリック、サイト名、URL、具体的な値、evidence の文面、ページの文章は書かないでください。
- 結果は ~/webhand-bench/analysis/completion-fv.md に日本語で書いてください。ほかのファイルは作らないでください。
- benchmark/ のファイルや .enc は開かないでください。
```

## 回 gv で、頼まれた作業が終わったかの調べ方（回 `gv1`・`gv2`、2026-11-14）

上の「v1 と v2 で、頼まれた作業が終わったかの調べ方」と同じ判定を、回 `gv1`（v1）と `gv2`（v2）の40セッションで行います（webhand `4c31542`、Sonnet 5.5）。プロンプトは、その節のものを次のように読み替えて使います。結果は `~/webhand-bench/analysis/completion-gv.md` に入ります。

- 対象: v1 は `~/webhand-bench/work-gv1/*` と `results-gv1/*`、v2 は `work-gv2/*` と `results-gv2/*` の20件ずつ。`invalid` というファイルがあるタスクは読まない。
- 止まった型に、次の2つを足す:「別の入口を試した（`replan --url`）が届かなかった」「利用者に返して、断られて終えた（AskUserQuestion）」。
- 5 の「違いの型」に、「覆われた対象（ログの stale の changed が target_covered）」と「Jev のリクエストの大きさ（JEV_FAILED、call の dropped_elements）」を足す。
- 結果のファイル名は `completion-gv.md`。表の見出しは「タスク ID / v1 / v2」。

## 回 hv で、頼まれた作業が終わったかの調べ方（回 `hv1`・`hv2`、2026-11-14）

「回 gv で、頼まれた作業が終わったかの調べ方」と同じ判定を、回 `hv1`（v1）と `hv2`（v2）の40セッションで行います（webhand `14980ae`、Sonnet 5.5）。その節の読み替えに、次を加えます。結果は `~/webhand-bench/analysis/completion-hv.md` に入ります。

- 対象: v1 は `~/webhand-bench/work-hv1/*` と `results-hv1/*`、v2 は `work-hv2/*` と `results-hv2/*` の20件ずつ。`invalid` というファイルがあるタスクは読まない。
- 「一覧や結果の一部しか読めなかった」の回について、ログの `collect_end` と `compare_end` の `stopped`（bottom、limit、pages）、`more` の `pressed` と `offered`（示した候補の数）を、型として数える。
- 出力に「NOT THE WHOLE LIST」が出た回で、Claude が `done` で終えたか `blocked` で終えたかを数える。
- 結果のファイル名は `completion-hv.md`。表の見出しは「タスク ID / v1 / v2」。

## タスクの和訳（人が手で確かめて、評価のタスクを選ぶため。2026-11-15）

BU Bench のタスクは海外のサイトが多く、人の手でも達成できるかを確かめていません。人が手で確かめるために、各タスクの指示文を和訳します。訳すのは指示文（エージェントに渡す文）だけで、ルーブリックや judge の出力は使いません。webhand を改善するセッションでは行わず、結果はコミットも公開もしません。

1. 新しいターミナルで次を実行します。

   ```sh
   uv run --project ~/webhand-bench/benchmark python "$REPO/research/bench/scripts/export_tasks.py"
   mkdir -p ~/webhand-bench/analysis && cd ~/webhand-bench/analysis && claude --strict-mcp-config
   ```

2. 下のプロンプトを貼り付けます。結果は `~/webhand-bench/analysis/tasks-ja.md` に入ります。
3. 選ぶ基準（たとえば「日本から人の手で開けて、最後までできる」）を、選ぶ前に決めて書き残してください。webhand がどう動いたかでは選ばないでください。選んだタスクの ID だけを、改善のセッションに渡してください。

```text
~/webhand-bench/analysis/tasks-raw.jsonl を読んでください。1行が1つのタスクで、task_id と confirmed_task（エージェントに渡す指示文）があります。
人が手で「達成できるか」を確かめるための一覧を作りたいので、各タスクについて次を書いてください。

- task_id
- 和訳: confirmed_task の日本語訳。固有名詞、URL、数値、日付は原文のまま残し、要求をひとつも落とさないこと。
- 対象のサイト: 指示文に出てくるサイト名や URL（指示文にないものは推測しない）
- 要りそうなもの: 指示文から読み取れる範囲で、ログイン、地域、日付の指定、成果物のファイル（なければ「なし」）
- 手順の数の目安: 指示文に出てくる要求の数（例: 「3社の比較」なら 3）

最後に、全タスクの一覧表（task_id / 対象のサイト / 要りそうなもの / 要求の数）を付けてください。
- 自分でサイトを開いたり、検索したりしないでください。指示文だけから書いてください。
- benchmark/ のファイル、.enc、results*/、work*/ は開かないでください。
- 結果は ~/webhand-bench/analysis/tasks-ja.md に日本語で書いてください。ほかのファイルは作らないでください。
```

## 回 sa・sb で、頼まれた作業が終わったかの調べ方（回 `sa`・`sb`、2026-11-15）

「回 gv で、頼まれた作業が終わったかの調べ方」と同じ判定を、回 `sa`（段階2の前、webhand `7931f3a`）と `sb`（段階2の全体、`062d37d`）の40セッションで行います（Sonnet 5.5、流れは v2）。プロンプトは `research/bench/analysis/prompts/prompt-sa-sb.txt` にあります。`gv`・`hv` の節のものに、次を加えてあります。結果は `~/webhand-bench/analysis/completion-sa-sb.md` に入ります。

- 止まった型に「利用者に返して（AskUserQuestion）、決まった答えで断られて終えた」を足した。
- 違いの型に、Jev の `ESCALATE` と Claude の `answer`、見えない領域の伝え方と早期停止、スクロール往復の停止、を足した。
- sb だけ: `ESCALATE` や `answer` のあとに作業が進んだか、WHY に見えない領域が出たあとに別の道を試したか、を数える。

新しいターミナルで、次を実行します（`eval-settings.json` は使いません）。

```sh
mkdir -p ~/webhand-bench/analysis && cd ~/webhand-bench/analysis && claude --strict-mcp-config "$(cat "$REPO/research/bench/analysis/prompts/prompt-sa-sb.txt")"
```

できた `completion-sa-sb.md` を、ご自身で読み、タスク固有の内容が入っていないことを確かめてから、改善のセッションに渡してください。

## `NOT_VISIBLE`（要素が一覧にない）の理由の調べ方（回 `sa`・`sb`、2026-11-15）

ログ（`not_visible` イベント）には、一覧に出た要素の数や、見えない領域の数しかありません。「必要だった要素が、なぜ一覧になかったか」は、ページを見て型にする必要があります。サイトの画面を読むので、**評価にも webhand の改善にも使わないセッション**で行います（judge の出力は読みません）。プロンプトは `research/bench/analysis/prompts/prompt-nv.txt`、結果は `~/webhand-bench/analysis/not-visible-sa-sb.md` に入ります。型は、canvas や iframe の中、標準の要素のない押せる見た目、別の操作のあとに現れるもの、別のタブやページ、覆われたもの、一覧の大きさの上限、読み込み中、ページに存在しない、その他、の9つ。

```sh
mkdir -p ~/webhand-bench/analysis && cd ~/webhand-bench/analysis && claude --strict-mcp-config "$(cat "$REPO/research/bench/analysis/prompts/prompt-nv.txt")"
```

できた `not-visible-sa-sb.md` を、ご自身で読み、タスク固有の内容が入っていないことを確かめてから、改善のセッションに渡してください。
