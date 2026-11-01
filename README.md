# browser-lab

Claude と Jev が役割を分担してブラウザを操作するエージェントの研究基盤です。Claude の判断回数とトークン消費を抑えながら、タスクの成功率を保つことを目指します。

Anthropic の API キーは使いません。作業中の Claude Code がスキルの手順に沿って CLI を実行し、Claude の役割を担います。

```
Claude Code ── スキル /browser-lab ──> CLI browser-lab ── CDP ──> 使い捨て Chrome
   計画・入力文・確認・最終判断            └── advance ──> Jev（手順内の操作を選択）
```

## 役割分担

| 担当 | 役割 |
| --- | --- |
| Claude | 目標を手順に分解する、入力文を書く、手順の完了を確認する、Jev が迷ったときに判断する、実行を締める |
| Jev | 現在の手順の中で、次の操作と対象を選ぶ |
| コード | 選択を観測済み要素に限定し、鮮度を確認して実行する。独立検証を行う |

Jev は現在の手順だけを受け取って動き続け、Claude の判断が必要なときに制御を返します。

| エスカレーション | 発生条件 | Claude の対応 |
| --- | --- | --- |
| `NEEDS_TEXT` | 文字入力が必要 | `advance --text "値"` |
| `STEP_DONE` | Jev が手順の完了を申告 | 確認して `advance --next` |
| `LOW_CONFIDENCE` | 確信度が閾値未満（既定 0.6） | `advance --accept` または `act` |
| `HUMAN_STEP` | 手順書で人の担当とされた手順 | ユーザーに依頼し、確認して `advance --next` |
| `JEV_BLOCKED` / `JEV_FAILED` / `STUCK` | 進行不能 | `act`、`plan` のやり直し、または `finish` |

## セットアップ

```bash
uv sync
cp .env.example .env   # TYPESAFE_API_KEY を設定
```

Chrome は導入済みのものを使います。起動のたびに一時プロファイルを作り、終了時に削除するため、ログイン情報は引き継ぎません。

## 使い方

Claude Code のセッションで、スキルを呼び出します。

```text
/browser-lab --task hotel_filter
/browser-lab --url https://example.com --goal "見出しを確認する"
```

コマンドはプロジェクトルートで実行します。

| コマンド | 担当 | 内容 |
| --- | --- | --- |
| `browser-lab start` | Claude | Chrome を起動し、最初のページを表示 |
| `browser-lab plan "手順" ...` | Claude | 手順を設定、またはやり直す |
| `browser-lab advance` | Jev | 現在の手順を、エスカレーションまで実行 |
| `browser-lab act OP [TARGET]` | Claude | Jev の代わりに操作を1つ実行 |
| `browser-lab observe` | Claude | 現在のページを表示 |
| `browser-lab finish --status STATUS` | Claude | 独立検証、ログ記録、Chrome の終了 |
| `browser-lab learn --name NAME --url URL` | 人 | 操作を記録 |

## 学習モード

人の操作、またはサービスのソースコードから手順書を作り、次回以降の実行に使います。手順書は機械的に再生せず、Claude の計画と Jev への指示として渡します。

```text
/browser-lab-learn --name myservice/search --url https://example.com
```

1. `browser-lab learn` が Chrome を開き、ユーザーの操作を記録します。ウィンドウを閉じると終了します。
2. Claude が記録またはソースコードから `runbooks/<service>/<name>.toml` の下書きを書きます。
3. `start --runbook NAME --param k=v --allow-draft` で試行します。
4. ユーザーが内容を確認し、`status = "approved"` にします。

```bash
browser-lab start --runbook myservice/search --param city=Lisbon
browser-lab plan --runbook
```

`actor = "human"` の手順では Jev も Claude も操作せず、`HUMAN_STEP` で止まります。ログインはここでユーザーが行います。`--headed` が必須です。Claude は資格情報を受け取りません。

記録の扱い:

- キー入力は記録しません。パスワード、ワンタイムコード、カード番号などの欄の値は `<redacted>` になります。ただし秘匿の判定は欄の属性と名前によるため、見分けられない欄の値は `runs/` の記録に残ります
- URL のクエリの値はすべて伏せます
- 記録は `runs/` に保存され、コミットしません。ページ本文を含みます
- iframe 内の操作、ファイル選択、新しいタブは再現できないため、`unsupported` として残します
- ページのスクリプトは記録を偽装できるため、記録は信頼せず、手順書はユーザーが承認します

**ログイン後のページの内容は Jev（TypeSafe の API）に送られます。** 個人情報を含む画面を扱うかどうかは、実行前に判断してください。

`verify()` のないサービスでは `verified` は `None` です。手順書の `done_when` は Claude の確認材料で、成功の証拠にはなりません。

## ログ

`runs/<時刻>/` に JSONL で出力されます。

| type | 内容 |
| --- | --- |
| `run_start` | 目標、閾値、Chrome、git commit、手順書 |
| `plan` | Claude の手順と、その出所（`claude` / `runbook`） |
| `human_step` | 人の手順の依頼と完了 |
| `call` | Jev の呼び出しごとのトークンと遅延 |
| `escalation` | Claude に戻した理由 |
| `step` / `step_result` | 実行した操作、判断者、確信度、ページの変化 |
| `handoff` | Claude が読む CLI 出力の文字数 |
| `run_end` | 自己申告の状態、独立検証の結果、役割ごとの集計 |

成功判定は `run_end.verified` です。`status=done` は申告にすぎません。Claude Code のトークン数は取得しないため、`handoffs`（Claude に戻した回数）と `handoff_chars`（読ませた文字数）を代理指標にします。

## タスクの追加

`tasks/<名前>.py` に次を定義します。

- `GOAL`: 自然言語の目標
- `start_url(root)`: 開始 URL
- `verify(browser)`: `{"success": bool, "evidence": ...}` を返す独立検証
- `SCRIPT`: 基盤の動作確認用の固定手順

## 開発

```bash
uv run ruff check .
uv run pytest                                         # 有料 API は呼びません
uv run python -m browser_lab.run --task hotel_filter  # モデルなしの動作確認
```

## ライセンス表記

`src/browser_lab/snapshot.js`、`policies/base.py`、`policies/jev.py`、`tasks/fixtures/hotel.html` は [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT）を改変したものです。`THIRD_PARTY_LICENSE_jev-ultrafast.txt` を参照してください。
