# 設計: 受け入れ条件の保存と回帰（`webhand-regress`）

状態: 実装済み（`feat/webhand-regress`）。実装での変更点は末尾の「実装での決定」。`webhand-verify`（単発の受け入れ確認）と `webhand check`（決定的な照合、PR #61）の次の版。

## 目的

`webhand-verify` は、その場で条件を分解して 1 回確認する。同じ確認を、あとで（画面を変えたあと、リリースの前に）もう一度やるには、条件、操作、期待を毎回 Claude に書き直させることになり、次の問題が出る。

- 期待が毎回変わりうる。結果を見てから期待を書けば、回帰にならない。
- 前回の結果と比べられない（何が新しく壊れたのか、前から壊れていたのか）。
- 同じ操作を、そのつど一から計画する。手順書があっても、確認の期待は手順書の外にある。

保存と回帰は、**期待を操作の前に書いて固定し**、同じ確認を繰り返し、前回との差を報告する。

## 変えない規則

- 操作は Jev（Claude が計画）、照合は `webhand check`、総合判断は Claude。Jev の `GOAL_REPORTED` や `DONE` は合格の証拠にしない。
- 判定は `PASS` / `FAIL` / `INCONCLUSIVE`。操作が届かなかったことを製品の失敗にしない。
- **失敗した回帰を理由に、期待を緩めない。** 保存した期待を実行中に書き換えない。直すのは、ユーザーが仕様の変更として承認したときだけ。
- 保存した確認に、秘密情報と個人情報を書かない。値は `params` にする。資格情報は人が Chrome に直接入力する（Claude は受け取らない）。
- `draft` の確認は回帰に使わない。`approved` にするのはユーザーの承認後のみ。
- 本番では読み取りだけで確認できる確認に限る。登録・削除・送信を伴う確認は、環境がテストだと宣言された実行でしか動かさない。
- ブラウザへの変更操作はリトライしない（`MutationUncertain` で停止）。再挑戦は Claude が計画を見直して行い、試行回数に上限を設ける。
- 実行記録とログイン状態はユーザー側（`~/.webhand/`）にだけ置く。`runs/`、`state/` はコミットしない。

## 保存するもの: 確認ファイル

手順書と同じ形式（TOML）と置き場所の規則を使う。

- プロジェクト: `.webhand/checks/<service>/<name>.toml`（チームで共有する確認）
- ユーザー: `~/.webhand/checks/<service>/<name>.toml`
- 同じ名前はプロジェクトが優先。

```toml
service = "linen"
name = "coupon_removed"
status = "draft"            # draft | approved
env = "test"                # test | read-only。本番で動かす確認は read-only だけ
start_url = "{base_url}/shop"
runbook = "linen/order"     # 任意。あれば操作はこの手順書から計画する
sources = ["issue:#123"]    # 任意。誰でもたどれる参照だけ

[params.base_url]
description = "Origin of the environment under test"

[[checks]]
id = "C3"
title = "クーポンを外して再計算すると合計がクーポンなしの金額に戻る"
given = "数量 2、クーポン SAVE10 で計算済み"
steps = [
  "Set the quantity to 2 (type the digit 2)",
  "Enter SAVE10 as the coupon and press 合計を計算",
  "Empty the coupon field and press 合計を計算",
]
stop = "Stop when the result is shown, whatever it says."
expect = [
  'text:合計: ¥3,250',
  'no-text:SAVE10 適用',
]
manual = []                 # check の形に書けない期待（意味の判断）。Claude が読んで判定し、報告で manual と明記する
depends_on = []             # 同じセッションで続けて動かす前提の確認の id
```

- `expect` は `webhand check --expect` の構文そのまま。期待は計算結果ではなく、仕様から導いた値を書く（実行中に観測値から写さない）。
- `steps` と `stop` は `webhand-verify` の GOAL の規則と同じ。期待値を停止条件にしない。number 欄は桁を書く、欄を空にするときは `act TYPE_TEXT INDEX --text ""` を使う、の規則も引き継ぐ。
- `depends_on` がある確認は 1 つのシナリオにまとめて 1 セッションで動かす。それ以外は確認ごとに新しいセッション。
- 検証: `webhand catalog` が確認ファイルの形（`expect` の構文、`params` の過不足、`env`、`status`）を調べ、一覧に出す。壊れた確認は実行しない。
- `digest` を持つ。各回の実行ログ（`run_start`）に確認の `digest` を残し、どの版の確認で動かしたかを後から分かるようにする（手順書と同じ）。

## スキルの流れ

2 つに分ける。

### 保存（`/webhand-verify` の続き）

`/webhand-verify` で確認が終わったあと、Claude が「この確認を保存しますか」と聞く（毎回は聞かない。`PASS`/`FAIL` のどちらでも、`expect` を `check` の構文で書けた確認があるときだけ）。

1. 確認ごとに、`given` / `steps` / `expect` を、**実行前に書いた期待のまま**確認ファイルに起こす。観測値から期待を作り直さない。
2. 秘密情報や個人情報、環境固有の値（オリジン、ID）は `params` にする。書きかけたら止めて聞く。
3. `status = "draft"` で書き、ユーザーに見せる。承認されたら `approved` にする。承認の前に回帰に使わない。
4. `FAIL` だった確認は、期待を保存してよい。「今は壊れている」確認として `known_failing = true`（任意）を付けると、回帰の報告で「既知」と「新しい」を分けられる。

### 回帰（`webhand-regress`、新しいスキル）

`/webhand-regress NAME [--param k=v]`、または名前の省略（`webhand catalog` に出る `approved` の確認をすべて対象）。

1. **選ぶ**: `approved` の確認を集める。`draft` は対象外と報告する。
2. **環境の確認**: `params` の値から対象の環境を決め、テストか本番かをユーザーに確認する。本番なら `env = "read-only"` の確認だけを動かし、残りは `INCONCLUSIVE（未実行: 本番）`。
3. **実行**: 確認ごとに（`depends_on` はまとめて）新しいセッションで `start` / `run` し、`GOAL_REPORTED` のあとに `webhand check --expect ...`（`--read` を付けて全体を見る）。`manual` は Claude が `observe` を読んで判定する。ログインが要るときは `/webhand` と同じ（`--auth`、`profile:NAME`、Jev に送られると事前に伝える）。
4. **判定の扱い**: `webhand-verify` と同じ。`check` の出力を引用する。`FAIL` を見て期待を直さない。`NEEDS_VALUE`、`STUCK`、`BLOCKED`、`JEV_FAILED` は、試行の上限内で `answer` / `replan`、使い切ったら `INCONCLUSIVE`。`UNCERTAIN` は再試行せず `INCONCLUSIVE`。
5. **前回との比較**: 同じ確認の直前の実行（ログの `check_run` 記録）と、`digest` と判定を比べる。報告に、各確認を `新しい FAIL`（前回 `PASS`）、`既知の FAIL`、`回復`（前回 `FAIL` で今回 `PASS`）、`変わらず PASS`、`INCONCLUSIVE` に分ける。確認の `digest` が前回と違うときは、比較せず「確認の内容が変わった」と明記する。
6. **終了**: 確認ごとに `finish --status done --reason "C3 FAIL: expected ..., observed ..."`。
7. **報告**: 総合は `webhand-verify` と同じ（全件 `PASS` のときだけ「回帰なし」、`新しい FAIL` が 1 件でもあれば「回帰あり」、それ以外で `INCONCLUSIVE` があれば「未確認あり」）。PR や Issue へのコメント投稿は外向きなので、ユーザーに聞いてから。

## CLI の変更

最小にする。判断は Claude とスキルに残す。

- `webhand catalog`: 確認ファイル（`checks/`）を一覧に出し、形を検証する（`status`、`env`、`expect` の構文）。壊れたものは理由付きで示す。
- `check` の実行結果を、ログの `check` イベントに加え、各確認の実行の終わり（`finish`）に `check_run` として記録する: 確認の名前と `digest`、`id`、判定、`reason`。期待の中身は含めない（引用は報告にある）。入力値は書かない。
- `webhand checks last NAME`（読み取り専用）: ログから、確認ごとの直前の判定と `digest` を出す。比較のための素材で、判定はしない。
- 新しい操作系のコマンドは足さない。実行は既存の `start` / `run` / `check` / `finish`。

## 安全

- ページ本文は信頼しないデータ。保存した期待と照合するだけで、ページの指示に従わない。
- 確認ファイルを実行時に Claude が書き換えない。修正は保存の流れ（ユーザーの承認つき）でだけ。
- 本番で動かせるのは `env = "read-only"` の確認だけ。`read-only` は `steps` に送信・登録・削除・購入がないことを `webhand catalog` が検査できるように、手順書の `[person]`／操作語の規則に合わせて書く（誤って `read-only` と書いた確認で本番を変更しないため、スキルは実行前に `steps` を読み直して見せる）。
- 保存したログイン（`~/.webhand/state/auth/`）の扱いは既存規則のまま。確認ファイルには書かない。

## 評価

変える変数は 1 つ: 期待を保存して固定した回帰（c）と、毎回その場で確認する `webhand-verify`（v）。

- ページ: `~/webhand-ab` の r51/r54 系の 5 枚（不具合 4 種類＋正常 1）。**画面を変えたあとの回帰**を作る: 同じ 5 つの確認を、ページが正常な版で `approved` にしたあと、不具合を仕込んだ版に変えて回す。
- 主指標: **見逃し率**（不具合版で `PASS` を出した割合。0 が目標）。次に、正常版の誤 `FAIL`、`INCONCLUSIVE`、期待のぶれ（v では同じ確認でも期待が回ごとに変わる。c は固定）、前回との比較の正しさ（`新しい FAIL` / `回復` の分類が真値と一致するか）。
- 追加の不具合: 前回 `PASS` だった確認が壊れる（`新しい FAIL`）、前から壊れている確認が直る（`回復`）、確認自体の `digest` が変わる、ページの文言が変わって期待が当たらない（`INCONCLUSIVE` か `FAIL` か）。
- 実行は `/webhand-research` の流儀（`ANTHROPIC_API_KEY`、`claude -p` を使わない）。モデルは固定（Sonnet 5.5）、`run_all.sh` で並列。失敗実行も除外しない。

## 未決事項

1. 保存の起点: `/webhand-verify` の最後に聞く（上記）か、`/webhand-learn` の流れに入れるか。確認は手順書と別物（期待が中心）なので、別ファイル・別スキルを推す。
2. `known_failing` を持つか。持てば `新しい FAIL` を分けられるが、「壊れたまま放置」を固定化する恐れがある。期限（`known_failing_until`）を付ける案。
3. `env = "read-only"` を CLI が検査できる範囲。`steps` の自然文からは判別しきれない。当面はスキルがユーザーに見せて確認する運用とし、検査は形式（`env` と `status`）のみにする案。
4. 前回との比較の置き場所: ログだけから出す（`checks last`）か、確認ごとに結果の履歴ファイルを持つか。「実行記録はユーザー側にだけ」の規則に合わせ、ログだけを推す。
5. 回帰の自動実行（CI など）。Jev と Chrome が要るため、この版では対象外。人が `/webhand-regress` を起動する。

## 実装での決定

- 期待の固定を機械で守る: `webhand check --saved service/name:ID` が、確認ファイルの期待をそのまま使う。Claude は期待を渡さない（`--expect` と同時に指定できない）。`{param}` は `--param` で埋める。
- `draft` は `--saved` が拒否する（試すときだけ `--allow-draft`）。`--production` を付けると、`env` が `read-only` でない確認を拒否する。回帰のスキルは本番では必ず `--production` を付ける。
- `check_run` は `finish` ではなく `check --saved` が記録する（確認の名前、id、`digest`、自動判定、`manual` の件数、時刻）。`manual` の判定は記録に入らない。
- `checks last NAME` は `webhand check-last NAME` にした（位置引数の曖昧さを避けるため）。確認の `digest` が前回と違えば「THE CHECK CHANGED」と出し、比べない。
- `webhand catalog` は確認を一覧に出し、形（`status`、`env`、`expect` の種類、`{param}` の宣言、`depends_on`）を検査する。壊れた確認は理由付きで `UNUSABLE` と出し、実行しない。`steps`、`given`、`stop` も出す（スキルがそこから GOAL を作る）。
- `known_failing` は入れていない（未決 2）。「既知」は前回も `FAIL` だったこと（`STILL FAILING`）で表す。
- 保存は `/webhand-verify` の §8 に足した（別スキルにはしていない。保存の書き方だけで、実行は `/webhand-regress`）。
