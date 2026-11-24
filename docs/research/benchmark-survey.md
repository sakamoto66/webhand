# ブラウザ操作ベンチマークの調査

状態: 2026-11-22 時点。Web 検索（検索結果の要約）からの整理で、各論文・公式ドキュメントの本文は読んでいない。数値は集計サイトや技術報告のもので、元の公式発表では未確認。「webhand への示唆」と「推奨」は調査からの推論で、実験では確かめていない。

## 1. 主なベンチマークと測り方

| ベンチマーク | 環境 | 成功の判定 | 弱点 |
|---|---|---|---|
| Mind2Web | オフライン（記録済みページ） | 正解の操作列の再現度 | 正解が 1 通り。別の正しい手順を取りこぼす。WebCanvas の調査では、サンプルの 12% が 1 年で期限切れ |
| WebArena / WebArena-Verified | 自前ホストのアプリ（812 タスク。難しい 258 件の部分集合あり） | プログラムによる決定的な検証（Verified は LLM judge なし） | Docker の構築が重い。一部のタスクは Docker の再初期化が必要。地図サイトは事前のデータ準備が要る |
| WebVoyager | 実サイト（643 件、15 サイト、1 サイト 40 件以上） | GPT-4o が軌跡と最終回答を見て判定 | 判定の不整合が監査で指摘されている。実サイトのためタスクが成立しなくなる。整理版の Emergence WebVoyager は 535 件 |
| Online-Mind2Web | 実サイト（300 件、136 サイト） | ルーブリック採点（Averaged／Perfect）。判定器 WebJudge の人間との一致は約 85% | 1 サイトあたり約 2 件。日付切れ。保守側が無効なタスクを定期的に入れ替える（2025 年 11 月に 36 件を修正） |
| OSWorld（Verified、2.0） | デスクトップ全体（369 タスク、6 分野） | プログラムによる検証。2.0 は部分点あり | ブラウザ以外も含む |
| BrowseComp | 検索・調査 | 短い答えの正誤 | 操作ではなく調査力を測る |
| WorkArena | ServiceNow（PDI が必要） | プログラムによる検証 | 検索では詳細を確認できていない |

ブラウザ操作そのものの比較で現在よく引用されるのは、Online-Mind2Web と WebArena-Verified。BU Bench は今回の検索では出てこなかった。

## 2. 判定方式の信頼性

- 判定は大きく 3 種類: プログラムによる最終状態の検証、LLM judge、正解操作列との一致。
- OpenComputer（2026）では、人間の判定との一致が、ハードコードした検証で 120 件中 113 件、LLM judge で 95 件。最終状態を直接見られる場合は、プログラムによる検証が信頼できる。
- AgentRewardBench（5 ベンチマーク、1,302 軌跡、12 の judge）では、どの場面でも優れた judge はなかった。
- ある論文では、GPT-4o の judge と人間の一致は 68%。
- Online-Mind2Web の論文は、ベンチマークと判定の問題が重なり、得点が実力より大きく出ていると指摘している。
- 成功率のほか、安全性・信頼性（ST-WebAgentBench）や、操作のばらつきへの頑健性（StressWeb）を測る試みもある。
- 得点は、実行の仕組み、judge、ステップ数の上限、版（WebArena の元版と Verified など）で変わる。異なる条件の得点は比べない。

## 2.5 モデル別の成績とハーネス・提出方式

Online-Mind2Web の「モデルごとの成績」は、モデル単体ではなく、モデルとハーネス（実行の仕組み）の組み合わせの成績。

- ハーネスで成績は数ポイントから数十ポイント、場合によっては数倍動く。ただし Online-Mind2Web でハーネスだけを変えた管理された研究は見つかっていない。
  - CUAWright（GPT-5.4、300 件）: 座標予測の従来方式 33.5%、コードで操作する方式 77.5%と報告。表の指標が混ざっている疑いがあり、操作方式そのものも変わるため、純粋なハーネス比較ではない。
  - AgenticVBench（GPT-5.5 固定）: ハーネスだけで Assembly が 38／37／18。別の組み合わせでは 8 倍の差。
  - コーディング（SWE-bench Pro）: 報告 50 台前半に対し、独立した標準環境の同モデルは約 45。
  - 領域も指標も別なので、足したり平均したりしない。
- HAL（Holistic Agent Leaderboard）の Online Mind2Web: 2 種類のハーネス（SeeAct、Browser-Use）に 12 モデルを載せた表。例: SeeAct と GPT-5 Medium 42.3%、Browser-Use と Claude Sonnet 4 40.0%。同じハーネスに複数モデルが載るので、モデル差は比較的見やすい。ただし新モデルの追加は止まっており、ハーネスのリポジトリは 2026-07-01 から読み取り専用。費用の数字は、実際の 2 倍に過大という既知の問題（2026-10-05）がある。
- HAL の論文は、同じハーネスで 4 モデル以上を評価したベンチマークは調べた中で 2 つだけと報告している。
- OSU の公式リーダーボード: 提出者が実行した軌跡（タスクごとの `result.json` とスクリーンショット）を送り、OSU 側が審査する。誰がエージェントを走らせるか、共通の実行環境があるか、API キーを誰が用意するかは、読んだ範囲では書かれていない。v2 提出スキーマの全文は未確認（ハーネスの記録欄の有無は不明）。
- Claude の行は、Browser-Use などの汎用ハーネスと API の組み合わせ。OSU の比較表には Claude Computer Use 3.5／3.7 と Operator が論文当時の軌跡として載る。Claude Code を使った測定は、見つかっていない（「ない」とは言えず、「見つけていない」）。
- webhand（Claude Code のスキルと Jev）は、公開得点のどのハーネスとも構成が違う。公開得点と並べて優劣は判断できない。学習前後の比較のように、ハーネスとモデルを固定して変数を 1 つにする設計なら、この問題を避けられる。

## 3. 日付切れ・時間依存の問題

BU Bench でホテル予約の日程が 2025 年（過去）だった懸念は、実サイトを使うベンチマークに共通する。

- 実サイト型（Online-Mind2Web、WebVoyager、Mind2Web-Live）は、サイトの変更と日付切れでタスクが成立しなくなる。WebVoyager は成立しなくなった約 48 件を除外し、時期に依存する約 50 件の日付を更新した版がある。Mind2Web-Live は約 100 件で、サイトの変更に弱いと原論文の著者が述べている。
- 影響を受けにくい型: WebArena 系（静的なホスト）、WebArXiv（時間で変わらない内容）、AssistantBench（答えが変わらないタスクだけ）。
- 対処の方針は 3 つ: 定期的な入れ替え、静的な固定、答えが変わらないタスクだけにする。統一された方法はない。

webhand への示唆（BU Bench の日付切れが得点にどれだけ影響したかは未調査）:

- 日付を含むタスクを数え、過去日付で実行不能になったものを、判定から外すか別の区分で集計する。結果には「日付切れで成立しなかった」を別区分として残す（CLAUDE.md の「失敗実行もログから除外しない」と両立する）。
- 日付に依存しない比較には、静的な WebArena-Verified が向く。

## 4. 学習前後の精度を測るベンチマークの選び方

### 必要な条件

1. 同じサービスのタスクが多い（学習が転用される）。
2. 学習用と評価用に分けられる（評価タスクの答えを学習に混ぜると、暗記を測ることになる）。
3. 判定がプログラムで、再現できる。
4. 学習前の得点に伸びしろがある（満点に近くても、ほぼ 0 でも差が出ない。r35 で満点のタスクが測れなかったのと同じ）。
5. 揺れが小さい（BU Bench はタスクごとの揺れが ±0.48）。

### 候補の比較

| 候補 | メリット | デメリット |
|---|---|---|
| WebArena-Verified | 静的で日付切れがなく再現できる。判定は決定的。同じサイトのタスクが多く、学習が転用されやすい（手元の知識ではサイトは 5 種。検索では未確認） | Docker の構築が重い。webhand の方式（1 操作ごとに Jev）で得点が出るかは未確認 |
| WebVoyager | 同じサイトのタスクが多い。実サイトでの効果が見える | 判定が LLM judge。日付切れとサイト変更の影響がある。Emergence 版（535 件）なら整理済み |
| Online-Mind2Web | 標準的で保守されている | 1 サイトあたり約 2 件で、学習が転用されにくい。日付切れ。judge の一致は約 85% |
| BU Bench | 実績のある手元の環境 | 揺れが大きく、学習の効果が埋もれた |
| 手元の `tasks/` を増やす | verify() で判定でき、学習の効果を測れた（r35: terms_scroll 0/8→6/8）。環境を制御できる | 自作で、一般のベンチマークとして主張しにくい |

### 推奨

1. WebArena-Verified の 1〜2 サイトに絞り、タスクを学習用と評価用に分ける。学習なしと学習ありを、評価用のタスクで対にして比べる（変える変数は学習の有無だけ）。先に数件で試走して、伸びしろを確認する。
2. 実サイトでの確認は、WebVoyager（Emergence 版）から 1〜2 サイトを選ぶ。判定は judge なので、`verify()` の成功とは呼ばず、別の指標として記録する。
3. Online-Mind2Web と BU Bench は、この目的には向かない。

WebArena-Verified の判定はプログラムだが `tasks/` の `verify()` ではない。CLAUDE.md の規則どおり、別の指標として扱う。

### 先に確認すること

- WebArena-Verified のサイトごとのタスク数と、Docker の再初期化の手順（公式ドキュメント）。
- webhand（ローカルの Chrome と Jev）が、ホストしたサイトに届くか。
- Online-Mind2Web の最新の修正版（2025 年 11 月以降）を使うか。

## 出典

- [Online-Mind2Web: An Illusion of Progress? Assessing the Current State of Web Agents](https://arxiv.org/html/2504.01382v4)
- [Online-Mind2Web (GitHub)](https://github.com/OSU-NLP-Group/Online-Mind2Web)
- [Online Mind2Web (Hugging Face)](https://huggingface.co/datasets/osunlp/Online-Mind2Web)
- [Online Mind2Web (HAL)](https://hal.cs.princeton.edu/online_mind2web)
- [AgentRewardBench](https://arxiv.org/pdf/2504.08942)
- [OpenComputer: Verifiable Software Worlds for Computer-Use Agents](https://arxiv.org/pdf/2605.19769)
- [WebArena-Verified (GitHub)](https://github.com/ServiceNow/webarena-verified)
- [WebArena-Verified README](https://raw.githubusercontent.com/ServiceNow/webarena-verified/main/README.md)
- [webarena-verified (PyPI)](https://pypi.org/project/webarena-verified/)
- [WebArena Verified (NeurIPS 2025)](https://neurips.cc/virtual/2025/124576)
- [WebVoyager (GitHub)](https://github.com/MinorJerry/WebVoyager)
- [princeton-pli/hal-harness](https://github.com/princeton-pli/hal-harness)
- [Holistic Agent Leaderboard (論文、HTML)](https://arxiv.org/html/2510.11977.pdf)
- [CUAWright: A Minimal Unified Interface for Digital Agents](https://arxiv.org/pdf/2610.04116)
- [AgenticVBench](https://arxiv.org/pdf/2605.27705)
- [Better Model vs. Better Harness (MindStudio)](https://www.mindstudio.ai/blog/better-model-vs-better-harness-agent-benchmark-score)
- [Coding Agent Harness Benchmarks](https://futureagi.com/blog/coding-agent-harness-benchmark/)
- [WebArXiv: Time-Invariant arXiv Tasks](https://arxiv.org/html/2507.00938v2)
- [BrowserGym Ecosystem](https://arxiv.org/pdf/2412.05467)
- [WebForge](https://arxiv.org/pdf/2604.10988)
- [ST-WebAgentBench](https://arxiv.org/html/2410.06703v5)
- [StressWeb](https://arxiv.org/pdf/2604.16385)
- [Holistic Agent Leaderboard](https://arxiv.org/pdf/2510.11977)
- [Browser-Agent Benchmarks 2026 (benchmarkingagents.com)](https://benchmarkingagents.com/best-benchmarks-for-browser-agents/)
- [AI Agent Benchmark Results (Steel)](https://leaderboard.steel.dev/results/)
- [Browser Agent Leaderboards, rebuilt (Steel)](https://steel.dev/blog/browser-agent-leaderboards-rebuilt)
- [Agent benchmarks explained (HoneyHive)](https://www.honeyhive.ai/learn/agent-benchmarks)
