# Jev クックブック・パターン一覧

TypeSafe の [Cookbooks](https://docs.typesafe.ai/cookbooks) に載っているレシピと、[Patterns](https://docs.typesafe.ai/patterns) に載っているパターンの一覧です。それぞれを webhand に活用できるかを、手分けして調査するための土台にします。

- 取得日: 2026-11-26(各索引ページと [llms.txt](https://docs.typesafe.ai/llms.txt) から作成)
- 日本語の題名と概要は、公式の英語の説明をもとにした訳です。各ページの調査結果は [1段階目レポート](./jev-cookbooks-report-1.md) と [2段階目レポート](./jev-cookbooks-report-2.md) にあります。

## 調査の進め方

- 着手するときに「担当」を埋めます。
- 「判定」は `活用できる`・`条件付き`・`対象外` のいずれかを書きます。理由は番号を見出しにして、末尾の「調査メモ」に書きます。

## Jev の特性と制約

調査で活用を判断するときの前提です。出典は [Model jaggedness](https://docs.typesafe.ai/model-jaggedness)(Jev の苦手な点)と [Models](https://docs.typesafe.ai/models)(仕様)です。苦手な点の多くは今後の版で直る見込みと書かれています。

### 向き不向き

常識的な判断を速く行い、確率が較正されていて、System One の(直接的な)タスクが得意です。指示は文字どおりに読み、間接参照や数値の精密さが必要なタスクは苦手です。

### 苦手な点と対処

| # | 苦手な点 | 内容 | 対処 |
| - | - | - | - |
| J1 | 文字どおりの解釈(Literal reading) | 意図ではなく書かれた条件に答える。範囲を限る語、否定、暗黙の条件もそのまま受け取る | 条件を `instructions` に正確に書き、境界の例は criteria に入れる。解釈が必要なら文字どおりの質問2つに分けてコードで組み合わせる |
| J2 | 計算と数値(Math and Numbers) | 数え上げ(文字、出現回数、長いリストの項目)が不安定で、対象が多いほど誤差が増える。16進数や RGB などの数値表現の比較も弱い。Score の出力から段階の間の正確な数値は復元できない(しきい値の判定には使える) | 計算と数え上げはコードで行う。条件に合う件数は候補ごとに1問ずつ聞いてコードで合計する。数値は計算済みの値か名前付きの区分にして渡す |
| J3 | 日付と時刻の比較(Date and time comparison) | 日付を順序のある量ではなく文字列として読む。前後、間隔、期間内かの判定は不安定。形式の混在、相対表現、四半期などの境界でさらに悪化する | 年・月・日の抽出を Choice(「記載なし」を含む)にし、比較と計算はコードで行う |
| J4 | 間接参照(Indirection) | 二重否定、属性の属性、複数段の推論で精度が落ちる | 直接的に書き、state の該当箇所を名前で指す |
| J5 | 無関係な情報が多い大きな state | 判断に関係ない内容が増えるほど精度が落ち、誤りの原因も追いにくくなる | 先にコードで絞り、質問に必要な項目だけ送る。絞れなければ Noul で関連性をふるい分ける |
| J6 | 敵対的な内容(Adversarial content) | state を敵対的とは扱わないため、埋め込まれた指示、誤解を誘う書き方、自分の分類を主張する文章で答えが動くことがある | criteria を明確に書き、公開前に境界の事例を十分にテストする |
| J7 | 指示と criteria の矛盾 | 両者の要求が食い違うと混乱する(例: Noul の `true` を「いいえ」に対応させる) | criteria は指示の延長として書き、明快で一貫した表現にそろえる |
| J8 | Choice の選択肢の順序 | 順序が答えに影響することがあり、先頭の選択肢に寄る | 順序を入れ替えても答えが同じか確認する |
| J9 | 文章生成(Generation) | 生成の訓練を受けていない。Choice の連鎖で無理に作ることはできるが、品質が低く非常に遅い | 候補を正規表現や生成モデルで作り、Jev に選ばせる。生成が必要なら別のモデルを使う |

まとめとして、公式は次を避けるよう勧めています。コードで正確に計算できることを聞く、1つの質問に複数の判断を詰める、System Two 型(間接参照が重なる)タスク、必要以上の情報を state に入れる。

### 仕様(取得日時点)

| 項目 | Jev 1.14(`jev-1.14.0`) | Jev 1.13(`jev-1.13.0`) |
| - | - | - |
| コンテキスト長 | 1リクエスト 64k / 1質問 32k | 同じ |
| 料金(入力のみ。出力は無料) | $0.042 / 100万トークン | 同じ |
| 入力 | テキスト、画像(PNG・JPEG) | 同じ |
| 質問の型 | Choice、Score、Noul、Box | Choice、Score、Noul |

- 「1リクエスト」は state と全質問の合計、「1質問」は state と質問1つの合計です。質問の数には別の上限はありません。
- `TypeSafe-Danger-Zone-Long-Context: true` ヘッダーを付けたリクエストでは、両方の上限が 262k になります(既定は無効)。
- 音声と動画の入力には対応していません。

## LLM とエージェント(LLMs and agents)

| # | レシピ | 原題 | 概要 | 難易度 | 担当 | 判定 |
| - | - | - | - | - | - | - |
| 1 | [関数呼び出し](https://docs.typesafe.ai/cookbooks/function_calling) | Function calling | 自然言語の取引依頼を、型付き関数の呼び出しに変換する。関数名と閉じた選択肢の引数を、確信度つきの質問に対応させる | 中級 | A | 活用できる(実装済み) |
| 2 | [スキル提案](https://docs.typesafe.ai/cookbooks/skill_suggestion) | Skill suggestion | 194個のスキルから1ターンにつき最大1つを選ぶ。2回のリクエストで上位候補の順位付けと再確認をする | 中級 | A | 対象外 |
| 3 | [LLM のガードレール](https://docs.typesafe.ai/cookbooks/llm_guardrails) | Guardrails for LLMs | LLM アプリの入出力を1リクエストで検査し、しきい値で通過・確認・遮断・サポート行きに振り分ける | 中級 | A | 条件付き |
| 4 | [引用の再確認](https://docs.typesafe.ai/cookbooks/citation_check) | Double-checking citations | 引用の前後の文脈が主張を裏付けるかを Choice 1問で判定し、誤引用や幻覚を見つける | 初級 | A | 活用できる(実装済み) |
| 5 | [LLM の回答を出典と照合](https://docs.typesafe.ai/cookbooks/verify_llm_outputs) | Verifying LLM answers against their source | 回答が与えた段落から導けるかを Noul 3問(1リクエスト)で調べ、疑わしいものをレビューに回す | 初級 | A | 条件付き |
| 6 | [RAG の取得文の分類](https://docs.typesafe.ai/cookbooks/classifying_rag_passages) | Classifying RAG passages | 取得した各文章を1リクエストで採点し、回答モデルに渡すものをコードで決める | 中級 | A | 条件付き |
| 7 | [簡易メモリ](https://docs.typesafe.ai/cookbooks/basic_memory) | Simple memory system | 覚える価値のある依頼と回答を Jev に選ばせ、後の呼び出しにメモリを付ける | 初級 | A | 条件付き |

## 分類(Classification)

| # | レシピ | 原題 | 概要 | 難易度 | 担当 | 判定 |
| - | - | - | - | - | - | - |
| 8 | [階層分類](https://docs.typesafe.ai/cookbooks/hierarchical_classification) | Hierarchical classification | Choice の確率を使う並列ビームサーチで、深い階層へ文書を分類する | 中級 | B | 条件付き |
| 9 | [確信度を使う分類](https://docs.typesafe.ai/cookbooks/classification_using_confidence) | Classification using confidence | 年次報告書を75業種に Choice 1問で分類し、確信度に応じて細分類か上位分類かを返す | 初級 | B | 条件付き |
| 10 | [Twitch チャットのフィルター](https://docs.typesafe.ai/cookbooks/twitch_chat_filter) | Twitch chat filter | メッセージごとに3問を並行実行し、コードのルールで非表示・ぼかし・強調を決める | 初級 | B | 対象外 |

## 抽出(Extraction)

| # | レシピ | 原題 | 概要 | 難易度 | 担当 | 判定 |
| - | - | - | - | - | - | - |
| 11 | [構造化抽出のカスケード](https://docs.typesafe.ai/cookbooks/sde_cascade) | SDE cascade | 安価なモデルで抽出し、各項目を Jev で検査して、失敗時だけ推論モデルに引き上げる | 中級 | B | 条件付き |
| 12 | [日付抽出](https://docs.typesafe.ai/cookbooks/date_extraction_cookbook) | Date extraction | 日付の構成要素を Jev に問い、コードで解決・検証して、確信度に応じてレビューに回す | 初級 | B | 条件付き |
| 13 | [事前解析した値の抽出](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook) | Pre-parsed value extraction | 正規表現で候補(メール・電話・金額)を拾い、Jev に選ばせて、その範囲をコードで正規化する | 初級 | B | 活用できる(実装済み) |
| 14 | [構造の復元](https://docs.typesafe.ai/cookbooks/autoformat) | Structure recovery | 書式を失ったテキストを2リクエストで Markdown に戻す(行の結合とブロック分類) | 初級 | B | 対象外 |
| 15 | [ショッピングカート](https://docs.typesafe.ai/cookbooks/cart_from_primitives) | Shopping cart | カフェの注文文を、選択肢を減らしながらの Choice ループと項目ごとの一括質問でカートにする | 初級 | B | 活用できる(実装済み) |

## 検索とマッチング(Search and matching)

| # | レシピ | 原題 | 概要 | 難易度 | 担当 | 判定 |
| - | - | - | - | - | - | - |
| 16 | [再ランキング](https://docs.typesafe.ai/cookbooks/rerank_typesafe) | Re-ranking | BM25 の候補30件を、クエリと候補の組ごとに1問で並べ替える | 初級 | C | 活用できる(実装済み) |
| 17 | [大量の選択肢からの Choice](https://docs.typesafe.ai/cookbooks/infinite_cardinality_choice) | Infinite cardinality choice | うろ覚えの説明から5,000本の映画を探す。作品ごとの Noul で絞り、上位20件に Choice | 中級 | C | 条件付き |
| 18 | [行ごとの検索](https://docs.typesafe.ai/cookbooks/semantic_find) | Line-by-line search | 規約の218行を Choice で1リクエスト採点し、答えがあるかを Noul で確認する意味検索 | 初級 | C | 活用できる(実装済み) |
| 19 | [ナレッジグラフのエンティティ照合](https://docs.typesafe.ai/cookbooks/entity_alignment) | Knowledge graph entity alignment | 2つのデータ源のレコード対を Score 1問で統合・手動確認・非リンクに振り分ける(Noul 3問で項目確認) | 初級 | C | 条件付き |
| 20 | [Intelliprompter(話者メモの消し込み)](https://docs.typesafe.ai/cookbooks/intelliprompter) | Intelliprompter | 発話の文字起こしを未消化のメモごとに採点し、しきい値を超えたら消し込む | 初級 | C | 条件付き |

## テクニック(Techniques)

| # | レシピ | 原題 | 概要 | 難易度 | 担当 | 判定 |
| - | - | - | - | - | - | - |
| 21 | [自己一貫性: Choice](https://docs.typesafe.ai/cookbooks/consistency_choice_cookbook) | Self-consistency: choices | 同じ判定を繰り返して決定が変わる頻度を測る(正解データ不要。LLM と比較) | 初級 | C | 条件付き |
| 22 | [自己一貫性: Noul](https://docs.typesafe.ai/cookbooks/consistency_noul_cookbook) | Self-consistency: nouls | 同じ保険請求を繰り返し問い、決定の揺れを測る(正解データ不要。LLM と比較) | 初級 | C | 条件付き |
| 23 | [並列質問](https://docs.typesafe.ai/cookbooks/parallel_questions) | Parallel questions | 13問を1回の呼び出しにまとめると、答えは同じで安く速くなることを示す | 初級 | C | 活用できる(実装済み) |
| 24 | [特徴量の自動探索](https://docs.typesafe.ai/cookbooks/autoresearch_feature_discovery) | Autoresearch feature discovery | LLM が質問を提案し、Jev の回答を特徴量に CatBoost を学習、誤りを次の提案に戻す | 上級 | C | 条件付き |

## 画像処理(Image processing)

| # | レシピ | 原題 | 概要 | 難易度 | 担当 | 判定 |
| - | - | - | - | - | - | - |
| 25 | [スキャンした接種記録の読み取り](https://docs.typesafe.ai/cookbooks/reading_scanned_documents) | Reading a scanned vaccination record | Noul と Box でワクチンを探し、接種年を Choice(読めないも可)で読み、有効期間を確認する | 中級 | D | 対象外 |
| 26 | [OCR の確信度と枠](https://docs.typesafe.ai/cookbooks/ocr_confidence_bounding_boxes) | OCR confidence and bounding boxes | OCR が読んだ請求書の値に枠を付け、全体と切り抜きの両方で採点して低得点を確認に回す | 中級 | D | 対象外 |
| 27 | [給餌カメラの訪問記録](https://docs.typesafe.ai/cookbooks/feeder_watch) | Feeder-cam visit log | 映像フレームに5問(うち Box 1問)を投げ、コードで鳥の種ごとの訪問記録にする | 中級 | D | 対象外 |

## パターン(Patterns)

[Patterns](https://docs.typesafe.ai/patterns) に載っている、TypeSafe を組み込むときの設計パターンです。番号はレシピと区別するため `P` を付けます。調査の進め方はレシピと同じです。

| # | パターン | 原題 | 概要 | 利点 | 担当 | 判定 |
| - | - | - | - | - | - | - |
| P1 | [投機的ファンアウト](https://docs.typesafe.ai/patterns/fan-out) | Speculative fan-out | 使うかもしれない質問も含めて1リクエストで多数送り、必要な答えはコードで選ぶ | コスト、速度 | D | 活用できる(実装済み) |
| P2 | [Noul で先にふるい分け](https://docs.typesafe.ai/patterns/noul-screen) | Screen with a Noul first | 安い Yes/No の質問を先に1つ投げ、明確に Yes のときだけ高価な段階を実行する | コスト、速度 | D | 条件付き |
| P3 | [併用 Noul](https://docs.typesafe.ai/patterns/companion-noul) | Companion Noul | Choice に「当てはまる選択肢があるか」の Noul を添え、該当なしをコードで検出する | 信頼性 | D | 条件付き |
| P4 | [確信度による振り分け](https://docs.typesafe.ai/patterns/confidence-routing) | Routing by confidence | Score の確信度が低い答えは人に回し、残りは点数で振り分ける | 信頼性、安全性 | D | 条件付き |
| P5 | [確率による振り分け](https://docs.typesafe.ai/patterns/probability-routing) | Routing by probability | 危険な操作ほど、実行に必要な確率のしきい値を高くする | 信頼性、安全性 | D | 条件付き |
| P6 | [複合スコア](https://docs.typesafe.ai/patterns/composite-scoring) | Composite scoring | 複雑な判断を個別の Score に分け、コードで管理する重みで1つの点数にまとめる | コスト、信頼性、速度 | D | 条件付き |

## 調査メモ

担当は A–D の 4 分担です。詳しくは [1段階目レポート](./jev-cookbooks-report-1.md) を参照してください。

### 1

活用できる(実装済み)・効果 低。値の Choice と NO_VALUE が同じ形。

### 2

対象外・効果 なし。Jev にスキルを選ばせる経路がない。

### 3

条件付き・効果 低。安全性向け。完了率の失敗には当たらない。

### 4

活用できる(実装済み)・効果 なし。check は完全一致を先に見る。

### 5

条件付き・効果 低。verifyClaims の誤判定の記録がない。

### 6

条件付き・効果 低。ブロック選択が完了を左右した記録がない。

### 7

条件付き・効果 低。別サイトの事実で悪化する差は雑音の範囲だった。

### 8

条件付き・効果 低。領域の取り違えが原因の失敗が示されていない。

### 9

条件付き・効果 低。既存ログで、変更操作の確信度ゲートは失敗を分けない。

### 10

対象外・効果 なし。製品に分類対象がない。

### 11

条件付き・効果 低。安いモデルの段は AGENTS.md に反する。

### 12

条件付き・効果 低。失敗している欄は形式を画面に出さない。

### 13

活用できる(実装済み)・効果 なし。値の番号を選ばせて原文を入力している。

### 14

対象外・効果 なし。構造は DOM で分かる。

### 15

活用できる(実装済み)・効果 なし。行ごとの一括判定が同じ役割。

### 16

活用できる(実装済み)・効果 低。catalog --match が Noul で順位付け。

### 17

条件付き・効果 低。行の読み込みの失敗が先にある。

### 18

活用できる(実装済み)・効果 なし。exists の Noul と Choice の組は matchFields にある。

### 19

条件付き・効果 低。しきい値の較正。誤判定の記録は確認していない。

### 20

条件付き・効果 低。消し込みは読み取りの蓄積にしか使えない。

### 21

条件付き・効果 低。研究の計測用。

### 22

条件付き・効果 低。unsure の行の再判定。件数が未確認。

### 23

活用できる(実装済み)・効果 なし。1 リクエストにまとめて送っている。

### 24

条件付き・効果 低。研究側のみ。

### 25

対象外・効果 なし。Jev に画像を送らない。

### 26

対象外・効果 なし。抽出は DOM テキスト。

### 27

対象外・効果 なし。映像を扱わない。

### P1

活用できる(実装済み)・効果 なし。単独の追加効果はない。複合案の土台。

### P2

条件付き・効果 低。drilldown は実装済み。

### P3

条件付き・効果 中。状態の信号を独立した Noul にできる。未検証。

### P4

条件付き・効果 低。ゲートは既存ログで支持されない。

### P5

条件付き・効果 低。同上(確率そのものはログで未分析)。

### P6

条件付き・効果 低。カタログの誤選択の記録がない。

### X1

条件付き・効果 低。読み取り専用の解除は人の承認にした設計と逆向き。

### X2

条件付き・効果 低。選択肢の順序(J8)は未測定。
