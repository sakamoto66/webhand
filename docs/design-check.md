# 設計: `webhand check`（決定的な確認コマンド）

状態: 実装済み（`feat/webhand-check`）。実装での変更点は末尾の「実装での決定」。`webhand-verify` の次の版。

## 目的

`webhand-verify` では、操作の後に Claude が `observe` の出力を読み、期待と照合して判定する。判定は 40/40（r50〜r52）で正しかったが、次の弱点が残る。

- 照合が毎回 Claude の読解に依存し、同じ条件でも揺れうる（r52 で空欄の扱いが 3 件 INCONCLUSIVE）。
- 長いページで、期待の文言が見える範囲の外にあると、`--read` の選び方で結果が変わる。
- 回帰（同じ確認を繰り返す）に使うと、判定の再現性が保証できない。

`webhand check` は、**セッションの現在のページに対する読み取り専用の照合**を CLI が行う。Claude が書いた期待値を、ページの観測済み要素と本文に対して機械的に比べ、`PASS` / `FAIL` / `INCONCLUSIVE` と引用した証拠を返す。操作はしない。

## 変えない規則

- 期待値を書くのは Claude（ユーザーの受け入れ条件から）。Jev は `check` に関わらない。モデル呼び出しなし、有料 API なし。
- `check` の結果は証拠であり、総合判断（`ACCEPT` / `REJECT` / `NOT CONFIRMED`）は Claude が下す。
- ブラウザへの変更操作をしない。クリック、入力、スクロールもしない（観測のみ）。リトライ不要。
- ページ本文は信頼しないデータ。`check` はページの指示を解釈しない。password 欄の値は読まず、`value` 照合の対象外（`INCONCLUSIVE: password`）。
- 期待値を結果を見てから緩めない。`check` は期待値の自動修正、あいまい一致の自動拡張をしない。

## コマンド

```
webhand check [--id ID] --expect KIND[:ARGS] ... [--within REGION]
```

`--expect` は複数指定でき、1 つずつ判定する。ページ状態は 1 回だけ観測し、同じスナップショットで全件を照合する（途中でページが変わって結果が割れないように）。

### 期待の種類（KIND）

| KIND | 意味 | 例 |
| --- | --- | --- |
| `text` | ページ本文に文字列がある（空白を正規化した完全一致の部分文字列） | `--expect text:"予約を完了しました"` |
| `no-text` | ページ本文にその文字列がない | `--expect no-text:"エラー"` |
| `field` | ラベルで指す要素の値が一致 | `--expect field:"合計"="15,000"` |
| `checked` | チェックボックス・ラジオの状態 | `--expect checked:"同意する"=true` |
| `count` | 条件に合う要素の数 | `--expect count:role=row="3"` |
| `url` | 現在の URL（パスまたは完全一致） | `--expect url:/complete` |
| `title` | ドキュメントの題名 | `--expect title:"完了"` |

- 比較は**厳密**が既定。正規表現、部分一致、数値の許容誤差は、明示した KIND（`field~` など）でだけ使い、既定では入れない。
- 数値は文字列として比べる（`15,000` と `15000` は別）。表記の違いを同じとみなす判断は Claude が期待値に書く。
- 対象が複数に当たるときは、すべてを証拠に出し、`field` は一致が 1 件に決まらなければ `INCONCLUSIVE: ambiguous`。

### 判定

各 `--expect` ごとに 1 件の結果。

- `PASS`: 観測した値が期待と一致。証拠として観測値を引用。
- `FAIL`: 対象は観測でき、値が違う、または `no-text` で見つかった。期待と観測の両方を引用。
- `INCONCLUSIVE`: 判定できない。理由コードを付ける。
  - `not_visible`: 対象が画面外、frame の中などで観測されていない（`--read` や `whole` を使うよう案内）。
  - `not_found`: ラベルに当たる要素がない（`FAIL` と混ぜない。対象がそもそもない場合は期待が観測可能な形でない）。
  - `ambiguous`: 対象が複数。
  - `password`: password 欄。
  - `stale`: 観測時点でページが遷移・更新中。

`FAIL` と `INCONCLUSIVE` の境界は `webhand-verify` と同じ。操作が届いたかは `check` では分からないので、「操作が条件どおり実行されたか」の確認は引き続き Claude が行動一覧から行う。

### 出力

`tests/golden/` の基準出力と一致させる。形式の案:

```
CHECK 3 expectations on https://example.test/complete (page 7f3a)
1 PASS   text "予約を完了しました"  found in main: "予約を完了しました。"
2 FAIL   field "合計"  expected "15,000"  observed "12,000"  (textbox #14)
3 INCONCLUSIVE not_visible  text "利用規約"  region footer not observed; use --read
RESULT: 1 PASS, 1 FAIL, 1 INCONCLUSIVE
```

- 終了コード: すべて `PASS` で 0、`FAIL` が 1 件でもあれば 1、`FAIL` なしで `INCONCLUSIVE` があれば 2。
- 入力値は出力しない。password 欄は値でなくラベルだけ。
- `RESULT` は証拠の集計であり、`ACCEPT` ではない。Claude が操作の実行確認と合わせて判断する。

### ログ

`check` の実行ごとに `check` イベントをセッションログへ追記する（期待、判定、引用した観測値。password 値と入力値は含めない）。`finish --reason` に Claude が結果を書く流れは変えない。

## `webhand-verify` スキルの変更

- §5「Judge」の手順 3 を変える。照合できる期待は `webhand check` で行い、その出力を引用する。`check` が書けない期待（意味の判断が要るもの、レイアウト）だけ Claude が読んで判定する。
- 期待値は操作の**前**に条件分解の段階で書き、結果を見てから書き換えない（既存の規則を、ログに残った `check` の期待で確認できるようにする）。
- `FAIL` を `INCONCLUSIVE` や `PASS` に直さない。`check` の `FAIL` は、操作が実行されたことを Claude が確認した上でだけ「不可」にする。

## 次の版: 保存と回帰

`check` だけでは「同じ確認の繰り返し」が書けない。これは別の版にする。

- 受け入れ条件を `.webhand/checks/NAME.md`（プロジェクト）または `~/.webhand/checks/NAME.md`（ユーザー）に保存する。内容は、前提、操作（手順書への参照または step）、期待（`--expect` の並び）、`params`。秘密情報と個人情報は書かず、値は `params` にする。
- 手順書と同じく `draft` / `approved` を持つ。`draft` は回帰に使わない。`approved` にするのはユーザーの承認後のみ。
- 回帰の実行も、操作は Jev（Claude が計画）、照合は `check`。失敗した回帰を理由に期待を緩めない。

## 実装範囲

- 新規: `src/commands/check.ts`、`src/check.ts`（照合の純関数）、`src/args.ts` に `--expect` と `--within`、`cli.ts` の `SESSION_COMMANDS` に `check`。
- 観測済み要素の値とラベルは既存の `render` と同じ情報源から読む。新しいブラウザ操作は足さない（`openPage` の観測のみ。`Browser.act` を経由しない）。
- `docs/reference*.md`、`docs/usage*.md`、`skills/webhand-verify/SKILL.md`、`README*.md` を更新。
- `npm test` に、照合の単体テスト（各 KIND の PASS / FAIL / 各 INCONCLUSIVE、password、複数一致、正規化）と golden を追加。ブラウザなしで通るよう、ページ状態は固定のスナップショットで与える。

## 評価

変える変数は 1 つ: 判定の主体（Claude の読解 / `check`）。

- `webhand-verify-research` の流儀（r48〜r52 と同じ、既知の不具合を仕込んだ版と正常版、`tasks/fixtures/hotel.html` 系、モデル固定、`run_all.sh`）。
- 主指標: 誤った PASS の率（目標は引き続き 0）。次に、正常版の誤 FAIL、`INCONCLUSIVE` の率、同一条件での判定の一致率（繰り返し 10 回）。
- 判定が `check` に寄って、r52 の「空欄」3 件のような INCONCLUSIVE が減るか、新しい誤 PASS（例: `text` が別の場所の同じ文言に当たる）が出ないかを見る。失敗実行も除外しない。
- 追加のテスト用の不具合: 同じ文言が別の場所にある（`text` の誤一致）、値の表記違い（`15,000` / `15000`）、非表示の要素。

## 未決事項

1. `text` の探索範囲の既定（見える領域のみか、`whole` までか）。誤 PASS を避けるなら、既定は見える領域のみ、範囲外は `not_visible`。
2. 表記ゆれ（全角半角、通貨記号）の扱い。既定は厳密一致とし、緩めるのは期待値側で Claude が明示する案。
3. `check` を `observe` の拡張（`observe --expect`）にするか、別コマンドにするか。読み取り専用という性質が同じで、別コマンドのほうが golden と権限が分かれて安全。

## 実装での決定

- 未決 1: 既定は見えている範囲。否定の結果（`text` の不在、`no-text` の PASS、`count`）は、ページ全体を見たとき（`--read` または `whole`、隠れた領域・切れた region・見えていない frame がない）だけ `FAIL` / `PASS` にし、そうでなければ `INCONCLUSIVE not_visible`。`text` が見つかった場合の `PASS` は範囲を問わない。
- 未決 2: 厳密一致（空白の正規化のみ）。緩めるのは期待値側。
- 未決 3: 別コマンド `check`。
- 終了コードは 0 / 6（FAIL）/ 7（INCONCLUSIVE）。2 は使用法の誤りに使われているため。
- 理由コードは `not_visible`、`not_found`、`ambiguous` の 3 つ。password 欄は観測されない要素（snapshot が除外）なので `not_found` になり、値は読まない。`stale` は 1 回の観測で照合するため不要。
- `--within` は region の本文を持たないため入れていない。
- `field` / `checked` は観測済みの入力要素だけが対象。画面上の文章として出る値（合計など）は `text` で照合する。
- `--read`（追加）: r54 で、`not_visible` のあと `replan --read` で読むと試行を 1 回使い、上限に達して INCONCLUSIVE になった。`check --read` はその呼び出しだけページ全体の本文を読み、セッションの view も試行も変えない。
