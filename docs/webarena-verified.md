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
      "use_header_login": true,
      "credentials": { "email": "emma.lopez@gmail.com", "password": "Password.123" }
    },
    "reddit": {
      "urls": ["http://localhost:9999"],
      "active_url_idx": 0,
      "use_header_login": true,
      "credentials": { "username": "MarvelsGrantMan136", "password": "test1234" }
    },
    "gitlab": {
      "urls": ["http://localhost:8023"],
      "active_url_idx": 0,
      "use_header_login": false
    }
  }
}
```

- `use_header_login: true` のサイトは、`start` 時に **HAR 記録の開始前** にサイト別 Auto-Login ヘッダーで事前アクセスして Chrome にセッション Cookie を定着させます。資格情報は CLI 引数・ホストエージェント・Jev・`network.har` のいずれにも渡りません。
- GitLab などヘッダー認証がないサイトは、通常の `webhand auth save` / `--auth NAME` で保存したログインを使用してください。

## 4. タスクの実行

コーディングエージェントから `/webhand-webarena-research <TASK_ID>` を実行します（直接コマンドを叩く場合は以下）。

```bash
# タスクの公開情報だけ確認（eval / expected は出力されない）
node research/webarena.ts info --task-id 108

# セッション開始（network.har を自動記録）
node research/webarena.ts start --task-id 108 --out-dir runs/webarena/round1 --step "..."

# Jev で実行・必要なら answer / replan / act
node research/webarena.ts run

# 終了（network.har フラッシュ + agent_response.json 出力、--eval で即時採点も可）
node research/webarena.ts finish \
  --status done \
  --task-type RETRIEVE \
  --wa-status SUCCESS \
  --retrieved-data '[{"month": "Jan", "count": 12}]' \
  --reason "Retrieved monthly counts from sales report" \
  --eval
```

出力ディレクトリにはタスクごとに以下が生成されます。

- `runs/webarena/round1/<task_id>/network.har`（権限 `0600`）
- `runs/webarena/round1/<task_id>/agent_response.json`（権限 `0600`）
- `runs/webarena/round1/<task_id>/webhand.jsonl`（webhand 実行ログ）
- `runs/webarena/round1/<task_id>/eval_result.json`（採点後）

## 5. 一括オフライン採点

```bash
node research/webarena.ts eval --output-dir runs/webarena/round1
# またはタスク・サイト絞り込み
node research/webarena.ts eval --output-dir runs/webarena/round1 --task-ids 0,1,2 --sites shopping_admin
```
