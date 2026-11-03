# browser-lab

Claude と Jev が役割を分担してブラウザを操作するエージェントの研究基盤です。Claude の判断を計画と見直しに絞りながら、タスクの成功率を保つことを目指します。

Anthropic の API キーは使いません。作業中の Claude Code がスキルの手順に沿って CLI を実行し、Claude の役割を担います。

```
Claude Code ── /browser-lab-learn ──> runbooks/<service>/  サービス情報と手順書
     │
     └──────── /browser-lab ── CLI browser-lab ── CDP ──> Chrome（新規 / 保存プロファイル、WSL では Windows 側も可）
       計画・入力値・確認・見直し       └── run ──> Jev（GOAL までの操作を選択）
```

## ユーザー体験

1. **学習する**: `/browser-lab-learn` で、人の操作の記録またはソースコードから、サービス情報と手順書を作ります。
2. **頼む**: `/browser-lab ホテルを予約して` のように投稿します。Claude が学習済みのデータから GOAL、手順、入力値を計画し、足りない情報はユーザーに質問します。
3. **セッションを選ぶ**: 新規（使い捨て）か、ログイン状態を残した保存プロファイルかを選びます。
4. **実行する**: 計画した URL を開きます。Jev は、サービス情報、計画、表示中のページ、これまでの操作履歴をもとに次の操作を選び、GOAL までループします。
5. **見直す**: GOAL に届かなければ、Claude が原因を書いて計画を見直し、再挑戦します（既定で最大3回）。

## 役割分担

| 担当 | 役割 |
| --- | --- |
| Claude | GOAL と手順を計画する、入力値を書く、足りない情報を質問する、結果を確認する、計画を見直す、実行を締める |
| Jev | GOAL までの操作ごとに、対象の要素と Claude の入力値のどれを使うかを番号で選ぶ |
| コード | 選択を観測済み要素と Claude の値に限定し、鮮度を確認して実行する。独立検証を行う |

`run` は、次のいずれかの場合にだけ Claude に制御を返します。

| 結果 | 発生条件 | Claude の対応 |
| --- | --- | --- |
| `GOAL_REPORTED` | Jev が GOAL 達成を申告した | ページを GOAL と照合し、`finish` か `replan` |
| `NEEDS_VALUE` | 入力欄に合う値が計画にない | `run --value "ラベル=値"`。わからなければユーザーに聞く |
| `NEEDS_HUMAN` | ログイン、認証コード、CAPTCHA、`[person]` の手順 | ユーザーに依頼し、`run --human-done` |
| `BLOCKED` / `STUCK` / `ATTEMPT_BUDGET` | 進めなくなった | `replan` で再挑戦、`act` で1手補う、または `finish` |
| `JEV_FAILED` | Jev の応答が使えない（何も実行していない） | もう一度 `run`、`replan`、または `act` |
| `UNCERTAIN` | 操作が実行されたかどうか不明 | 繰り返さず、`finish --status error` |

確信度は記録しますが、Jev を止める条件には使いません。

## セットアップ

```bash
uv sync
cp .env.example .env   # TYPESAFE_API_KEY を設定
```

### セッション

| `--session` | 内容 |
| --- | --- |
| `new`（既定） | 一時プロファイル。ログインしていない状態で始まり、終了時に削除されます |
| `profile:NAME` | browser-lab 専用の保存プロファイル。ログイン状態が次回も残ります |

```bash
browser-lab profile login work --url https://example.com/login   # 人がログインしてウィンドウを閉じる
browser-lab profile list
browser-lab profile delete work
```

普段使いの Chrome プロファイルには接続しません。Chrome 136 以降は、既定のプロファイルへのデバッグ接続ができないためです。保存プロファイルは、Linux では `.browser-lab/profiles/`、Windows では `%LOCALAPPDATA%\browser-lab\profiles\` に置かれます。

**ログイン後のページの内容は Jev（TypeSafe の API）に送られます。** 個人情報を含む画面を扱うかどうかは、実行前に判断してください。

### WSL で Windows 側の Chrome を使う

`--chrome auto`（既定）は、WSL 上で Windows の `chrome.exe` に接続できればそれを使い、できなければ Linux の Chrome を使います。`--chrome windows` または `--chrome linux` で固定でき、`BROWSER_LAB_CHROME` でも指定できます。

Windows の Chrome は、デバッグポートを Windows の 127.0.0.1 で待ち受けます。そのため、WSL のネットワークを mirrored にする必要があります。

```ini
# %USERPROFILE%\.wslconfig
[wsl2]
networkingMode=mirrored
```

設定したら、PowerShell で `wsl --shutdown` を実行して WSL を再起動します。ローカルファイルの URL は `file://wsl.localhost/...` に変換して開きます。

## 使い方

Claude Code のセッションで、スキルを呼び出します。

```text
/browser-lab HOTEL PLANISPHERE で来月の土曜から2泊、2名で予約して
/browser-lab --task hotel_filter
```

コマンドはプロジェクトルートで実行します。

| コマンド | 担当 | 内容 |
| --- | --- | --- |
| `browser-lab catalog` | Claude | 学習済みのサービス、手順書、保存プロファイルを一覧する |
| `browser-lab start --goal G --url U --step S ... --value L=V ... --session ...` | Claude | 計画を記録し、Chrome で開始 URL を開く |
| `browser-lab run` | Jev | GOAL まで操作する |
| `browser-lab replan --reason R [--step ...] [--value ...] [--restart]` | Claude | 計画を見直して、次の試行を始める |
| `browser-lab act OP [TARGET]` | Claude | Jev の代わりに操作を1つ実行する |
| `browser-lab observe` | Claude | 現在のページを表示する |
| `browser-lab finish --status STATUS` | Claude | 独立検証、ログ記録、Chrome の終了 |
| `browser-lab learn --name NAME --url URL` | 人 | 操作を記録する |
| `browser-lab profile login/list/delete` | 人 | 保存プロファイルを管理する |

手順の先頭に `[person]` を付けると、人が行う手順になります（`--headed` が必須です）。`--runbook NAME --param k=v` を指定すると、手順書の GOAL、開始 URL、手順が既定値になり、params は入力値として Jev に渡されます。

## 学習モード

人の操作、またはサービスのソースコードから、次の2種類のファイルを作ります。

| ファイル | 内容 | 使われ方 |
| --- | --- | --- |
| `runbooks/<service>/service.toml` | サービスの説明、ログインの要否、ページの一覧、Jev 向けの事実 | `catalog` で Claude が読み、`--service` で Jev に渡す |
| `runbooks/<service>/<name>.toml` | 手順書（goal、params、steps、hints、done_when） | Claude の計画の下敷き。手順と hints は Jev にも渡す |

```text
/browser-lab-learn --name myservice/search --url https://example.com
```

1. `browser-lab learn` が Chrome を開き、ユーザーの操作を記録します。ウィンドウを閉じると終了します。ログインした状態で操作を見せる場合は、`--session profile:NAME` を付けます。
2. Claude が記録またはソースコードから、サービス情報と手順書の下書きを書きます。
3. `--runbook NAME --param k=v --allow-draft` で試行します。
4. ユーザーが内容を確認し、`status = "approved"` にします。

手順書は機械的に再生しません。

記録の扱い:

- キー入力は記録しません。パスワード、ワンタイムコード、カード番号などの欄の値は `<redacted>` になります。ただし秘匿の判定は欄の属性と名前によるため、見分けられない欄の値は `runs/` の記録に残ります
- URL のクエリの値はすべて伏せます
- 記録は `runs/` に保存され、コミットしません。ページ本文を含みます
- iframe 内の操作、ファイル選択、新しいタブは再現できないため、`unsupported` として残します
- ページのスクリプトは記録を偽装できるため、記録は信頼せず、手順書はユーザーが承認します

`verify()` のないサービスでは `verified` は `None` です。手順書の `done_when` は Claude の確認材料で、成功の証拠にはなりません。

## ログ

`runs/<時刻>/` に JSONL で出力されます。

| type | 内容 |
| --- | --- |
| `run_start` | 目標、Chrome（linux / windows）、セッションの種類、git commit、手順書、サービス |
| `plan` | 試行ごとの手順、入力値のラベル、その出所（`claude` / `runbook`）、`restart` |
| `call` | Jev の呼び出しごとのトークンと遅延 |
| `step` / `step_result` | 実行した操作、試行番号、判断者、確信度、ページの変化 |
| `escalation` | `run` が Claude に返した結果 |
| `human_step` / `values` | 人の手順の依頼と完了、追加された入力値のラベル |
| `attempt_end` | 試行の結果と、Claude が書いた見直しの理由 |
| `handoff` | Claude が読む CLI 出力の文字数 |
| `run_end` | 自己申告の状態、独立検証の結果、試行回数と試行ごとの結果、役割ごとの集計 |

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
uv run pytest                                         # 有料 API は呼びません。Linux の Chrome を使います
uv run python -m browser_lab.run --task hotel_filter  # モデルなしの動作確認
```

## ライセンス表記

`src/browser_lab/snapshot.js`、`policies/base.py`、`policies/jev.py`、`tasks/fixtures/hotel.html` は [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)（MIT）を改変したものです。`THIRD_PARTY_LICENSE_jev-ultrafast.txt` を参照してください。
