# WebArena-Verified でのベンチマーク測定ガイド

[ServiceNow/webarena-verified](https://github.com/ServiceNow/webarena-verified) を使って `webhand` の決定論的・オフライン評価を行う手順です。研究用リポジトリ限定（`research/` と研究用スキル）で、npm 配布物には含まれません。

> [!IMPORTANT]
> `AGENTS.md` の規則に従い、WebArena-Verified の採点結果は `webarena_verified_score` として扱い、`tasks/` の独立検証 `verify()` による成功とは区別して記録します。失敗実行もログ・出力から除外しません。

## 1. 環境の起動（Docker）

評価対象のサイトを `uvx webarena-verified env start` で起動します。

```bash
uvx webarena-verified env start --site shopping_admin
# 他サイト例: shopping, reddit, gitlab, wikipedia, map
```

- **メモリ・逐次実行の注意**: `gitlab` コンテナ単体で約 3 GiB RAM を消費するため、8 GiB 程度の環境で複数サイトを同時起動すると headless Chrome の起動に失敗しやすくなります。使わないサイトは `uvx webarena-verified env stop --site <SITE>` で停止し、特に `gitlab` は 1 セッションずつ逐次実行してください。
- **`MUTATE` タスクの独立性**: 同一コンテナで `MUTATE` タスクを連続実行すると前の変更が環境に残ります。厳密な再現・比較を行うラウンド前後には `uvx webarena-verified env stop --site <SITE> && uvx webarena-verified env start --site <SITE>` でコンテナを再作成して環境を初期化してください。
- **`map` サイトの注意**: `map` は通常の Docker 起動だけでは完結せず、OSM / Nominatim / OSRM 用の大容量バックエンドデータ（数百 GB 規模）が別途必要になります。

## 2. データセットの取得

`state/`（`.gitignore` 済み）へデータセットを取得します。

```bash
mkdir -p state/webarena
# 全 812 タスク
uvx webarena-verified dataset-get --output state/webarena/webarena-verified.json
# または Hard 部分集合（258 タスク）
uvx webarena-verified subset-export --name webarena-verified-hard --output state/webarena/webarena-verified-hard.json
```

## 3. ローカル設定（任意・Auto-Login 対応）

`state/webarena/config.json`（または `WEBARENA_CONFIG` で指定するパス）を `WebArenaVerifiedConfig` 互換 JSON で作成すると、カスタムポートや最適化 Docker イメージの Auto-Login ヘッダー事前認証が使えます（コミット禁止）。

```json
{
  "test_data_file": "state/webarena/webarena-verified.json",
  "agent_response_file_name": "agent_response.json",
  "trace_file_name": "network.har",
  "eval_result_file_name": "eval_result.json",
  "environments": {
    "shopping_admin": {
      "urls": ["http://localhost:7780/admin"],
      "active_url_idx": 0,
      "use_header_login": true,
      "credentials": { "username": "admin", "password": "admin1234" }
    },
    "shopping": {
      "urls": ["http://localhost:7770"],
      "active_url_idx": 0,
      "use_header_login": false,
      "credentials": { "email": "emma.lopez@gmail.com", "password": "Password.123" }
    },
    "reddit": {
      "urls": ["http://localhost:9999"],
      "active_url_idx": 0,
      "use_header_login": false,
      "credentials": { "username": "MarvelsGrantMan136", "password": "test1234" }
    },
    "gitlab": {
      "urls": ["http://localhost:8023"],
      "active_url_idx": 0,
      "use_header_login": false,
      "credentials": { "username": "byteblaze", "password": "hello1234" }
    }
  }
}
```

- `shopping_admin`（`use_header_login: true`）は `X-M2-Admin-Auto-Login` ヘッダーで、`shopping`・`reddit`・`gitlab`（`use_header_login: false` + `credentials`）はローカルテスト環境向けフォーム送信で、いずれも `start` 時の **HAR 記録開始前** に事前認証して Chrome にセッション Cookie を定着させます。資格情報は CLI 引数・ホストエージェント・Jev・`network.har` のいずれにも渡りません。
- `--auth NAME` を明示した場合は事前認証をスキップし、保存済みログインをそのまま使用します（`--auth` や事前認証で開いたページは Jev に送信されます）。

## 4. 事前チェックとタスク一覧

資格情報や期待値（`eval` / `expected`）を一切表示せずに、環境確認と対象タスクの抽出ができます。

```bash
# データセット・空きメモリ・サイト疎通・認証方式（秘密は非表示）を確認
node research/webarena.ts doctor --sites gitlab

# サイト別・テンプレート代表タスクを一覧表示（中断後の未実行だけ絞る場合は --pending --out-dir DIR）
node research/webarena.ts list --sites gitlab --one-per-template
```

## 5. タスクの実行

コーディングエージェントから `/webhand-webarena-research <TASK_ID>`（またはサイト指定のまとめ実行）を実行します（直接コマンドを叩く場合は以下）。

```bash
# タスクの公開情報だけ確認（eval / expected は出力されない）
node research/webarena.ts info --task-id 108

# セッション開始（network.har を自動記録）
node research/webarena.ts start --task-id 108 --out-dir runs/webarena/round1 --step "..."

# Jev で実行・必要なら answer / replan / act
node research/webarena.ts run

# 終了（network.har フラッシュ + agent_response.json 出力、--eval で即時採点も可）
# --eval は既定で 1 行サマリーのみ出力。全文ログを見たい場合は --verbose を併用
node research/webarena.ts finish \
  --status done \
  --task-type RETRIEVE \
  --wa-status SUCCESS \
  --retrieved-data '[{"month": "Jan", "count": 12}]' \
  --reason "Retrieved monthly counts from sales report" \
  --eval
```

複数タスクの実行には [herdr](https://herdr.dev) が必要です（起動した状態で実行します。なければ起動時に停止します。1 件の実行には不要です）。1 件ごとの新しいセッションを herdr で並列に実行します（進捗パネル付き、既定 3 並列）。研究用スキルに複数の ID やサイトを指定すると、これが使われます。サイトのデータを変えるタスクは `--serial` に指定し、他がすべて終わってから 1 件ずつ実行します。

```bash
node research/batch.ts --webarena 0,11,423 --serial 423 --model claude-sonnet-5-5 --out runs/webarena/round1
```

出力ディレクトリには実行メタデータ（`run_meta.json`）と、タスクごとに以下が生成されます。

- `runs/webarena/round1/<task_id>/network.har`（権限 `0600`）
- `runs/webarena/round1/<task_id>/agent_response.json`（権限 `0600`）
- `runs/webarena/round1/<task_id>/webhand.jsonl`（webhand 実行ログ）
- `runs/webarena/round1/<task_id>/eval_result.json`（採点後）

## HTML レポート

`WEBHAND_SCREENSHOTS=1` で実行したラウンドは、画面付きの HTML レポートにできます（一括実行では自動で作成）。`DIR/index.html` とタスクごとのページ（`DIR/<ID>/<ID>.html`）に、タスク内容、採点と状態、計画、各ステップと画面、各ファイル（`eval_result.json` を含む）へのリンクが並びます。

```bash
node research/webarena.ts html --output-dir runs/webarena/round1
```

どのステップまで想定どおりだったかは自動では判定しません。ログを調べた結果を `DIR/notes.json`（`{"491": {"ok_until": 9, "summary": "…", "detail": "…"}}`）に書いて再実行すると、一覧とステップの色分けに反映されます。`eval_result.json` からは score と status だけを読みます。画面には入力値が写り、HAR には Cookie が含まれるため、レポートは共有しないでください。

## 6. 一括オフライン採点と集計レポート

```bash
node research/webarena.ts eval --output-dir runs/webarena/round1
# またはタスク・サイト絞り込み
node research/webarena.ts eval --output-dir runs/webarena/round1 --task-ids 0,1,2 --sites shopping_admin

# 失敗・blocked・未完了を含む全タスクの Markdown / JSON 集計表を出力（期待値詳細は非表示）
node research/webarena.ts report --output-dir runs/webarena/round1
node research/webarena.ts report --output-dir runs/webarena/round1 --format json
```
