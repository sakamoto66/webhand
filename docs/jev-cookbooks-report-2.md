# Jev クックブック活用調査 2段階目: 複合した使い方

調査日: 2026-11-26。項目ごとの評価は [1段階目レポート](./jev-cookbooks-report-1.md)。

## 1. 結論

- **「入れれば効果が高い」と言える組み合わせは、現時点ではありません。**
- 組み合わせの中で一番ましなのは **案 A** ですが、後の検証で対象の失敗がなくなり、見込みは **低** です(11 節)。**効果が中以上と言える組み合わせは残っていません。**
- **確信度で変更操作を止める案は勧めません。** 既存の実行ログで、止める回数が成功した実行と失敗した実行でほぼ変わりませんでした(2 節)。
- 完了を妨げている主な原因(実サイトの bot 検査・地域制限・読み込み失敗、サービス固有の知識の不足)は、クックブックの技法の対象外です。前者は過去の記録で 20 件中 11 件、後者は学習した事実で改善した記録があります。
- 設計を作り直す根拠もありません。1 リクエストへのまとめ、候補をコードで作って Jev に番号を選ばせる形、Noul の絞り込みは実装済みです。

## 2. 統合時の検証: 確信度は使えるか

1段階目で P4・P5・レシピ 9 の担当がそれぞれ有力候補に挙げたので、手元の実行ログ(API 呼び出しなし)で確かめました。

対象: Jev の操作があり `verify()` の結果が残る **957 実行(成功 710、失敗 247)**。

### 変更操作(click・fill・select)の確信度がしきい値未満なら止めた場合

| しきい値 | 成功した実行のうち止まる割合 | 失敗した実行のうち止まる割合 |
| - | - | - |
| 0.1 | 1% | 4% |
| 0.2 | 4% | 7% |
| 0.3 | 12% | 13% |
| 0.5 | 42% | 34% |

どのしきい値でも、失敗だけを選んで止められません。全操作で見ると、0.7 で成功の 69% と失敗の 87% が止まります。成功の 3 分の 2 を失う設定です。

### 同じタスク内で、失敗した実行の方が低いか

値は、失敗と成功の組で失敗側が低い割合です。0.5 は区別できないことを表します。

| 見る値 | 割合 |
| - | - |
| 最初の 1 手の確信度 | 0.44 |
| 最初の 3 手の最小値 | 0.42 |
| 全操作の最小値 | 0.42 |
| fill の最小値 | 0.40 |
| click の最小値 | 0.59 |
| **全操作の平均** | **0.87** |

- 早い段階の確信度は失敗を予測しません。
- 実行全体の平均は失敗と相関します。ただし終了後に分かる値で、道を外れた後の判断も含みます。実行前のゲートには使えません。
- 全タスクで同じ向きではありません(`off_plan_purge` などは失敗の方が高い)。

**限界**: 3 週間分のログで、コードの版と実験条件が混ざっています。ローカルのタスクだけです。見たのは確信度で、選んだ選択肢の確率(P5)は分析していません。

## 3. 失敗の記録と技法の対応

| 観測された失敗 | 今の状況 | クックブックで効くか |
| - | - | - |
| 実サイトの bot 検査・地域・読み込み | 未解決 | 効かない |
| `date_format`: 形式を示さない欄に誤った日付を保存して done | 学習した事実で 2/8 → 8/8 | 画面に情報がないので、Jev の質問では直らない |
| `terms_scroll`: 規約を最後まで読まないとボタンが押せない | 学習した事実で 0/8 → 6/8、`--service` 付きで 8/8 | 知識の問題。効かない |
| `qty_stepper`: 繰り返し押せない | 解決済み(0/8 → 8/8) | 不要 |
| `plan_more`: `--compare` なしで最初の組から選ぶ | スキルは `--compare` を指示する(11 節) | 不要 |
| `collect_*` の失敗 | ログに失敗がある。原因はこの調査で未分析 | 不明 |
| ヘッダーのログインで誤って停止 | 解決済み(PR #106) | 不要 |

## 4. 組み合わせ案

### 案 A: 状態の併用 Noul とコードの方針表(P1 + P3 + 23、考え方は 5 と P5)— 見込み: 低(11 節で引き下げ)

**狙い**: 今の `choose` は「どの操作か」の Choice に判断が集まっています。確定の前提になる事実だけを、同じリクエストの独立した Noul として聞き、扱いはコードで決めます。

最初の対象は 1 つに絞り、`plan_more` の型にします。

| 段 | 内容 |
| - | - |
| 質問 | `--read` があるときだけ追加する Noul「読み取っている一覧には、まだ読み込まれていない行がある」 |
| コード | Noul が高い状態で Jev が `DONE` か一覧内の行の `CLICK` を選んだら実行せず、履歴に理由を残して選び直させる。回数に上限を置く(`verifyClaims` の 2 回と同じ形) |
| 費用 | リクエスト数は増えない(23 並列質問、P1)。上限で選び直す分は増える |

**先に確かめること(安い順)**

1. API なし: `plan_more` の state に、行がまだあると分かる情報が入っているか。ページには「Scroll down for more plans.」がありますが、表の外の段落なので、`--read table` の読み取りに含まれない可能性があります。過去のダイアログ判定の Noul は、state に情報がなくて失敗しました。
2. 情報がない場合は、**Noul より先にコードの修正**を検討します(読み取り対象の一覧の直後にある状態表示を state に含めるなど)。これで足りれば Noul は要りません。
3. 情報がある場合は、固定ページで Noul だけを測ります(続きがある・ないの両方を各数回。ページ送りや「全件表示」も含める)。
4. 分かれた場合だけ、`plan_more` と `settings_long`・`plan_lowest` で 1 変数の A/B をします。成功判定は `verify()` です。

**危険**

- 無限スクロールのページでは常に「続きがある」になり、`ATTEMPT_BUDGET` が増えます。目的に十分な行が揃っている場合の扱いを質問に書く必要があります(J1)。
- Noul を種類ごとに足すと、規則が矛盾します(J7)。1 つずつ、観測した失敗に対してだけ足します。
- AGENTS.md: 操作の選択は Jev のままです。コードは実行前に差し戻すだけで、変更操作のリトライには当たりません。golden の更新が必要で、実験の変数として扱います。

### 案 B: 判定の計測キット(21 + 22 + 19 + J8)— 完了率への直接の効果: 低、費用: 小

研究側だけで、固定の state に対して次を測ります。

- 同じ質問を繰り返して答えが変わる割合(21・22)
- 選択肢の順序を入れ替えて答えが変わる割合(J8)
- drilldown の 0.7 / 0.3 と、正解の対応(19)

案 A のしきい値決めに同じ仕組みを使えます。単独で何かが改善するわけではありません。有料の Jev 呼び出しがあるので、テストには入れません。

### 案 C: 引き渡しに確信度の要約を添える(P4 + 9)— 見込み: 低、保留

実行を止めず、`run` の結果に「確信度が全体に低い」と添え、ホストの確認を厚くする案です。平均の 0.87 が根拠の候補ですが、2 節のとおり交絡があります。進めるなら、版と条件を揃えたログで再分析してからです。ホストは今も完了を自分で確認するので、上乗せの効果は小さいかもしれません。

### 案 D: 安全の層(3 + 6 + X1 + P5)— 目的が安全の場合だけ

ページ本文の指示の混入を Noul で検出し、ホストへの出力に注意を付けます。**Noul の答えで拒否を緩めない**こと(厳しくする方向にだけ使う)を条件にします。敵対的な内容は Jev の苦手な点(J6)で、r58 の注入ページでは誰もボタンを押していません。完了率は上がりません。

## 5. 勧めない組み合わせ

| 案 | 理由 |
| - | - |
| 確信度・確率のゲートで `ESCALATE`(9 + P4 + P5) | 2 節。ホストへの引き渡しが増え、成功する実行を止める |
| 安いモデルで提案し Jev で検査(11) | 役割分担と API 直接呼び出しの規則に反する |
| 領域のビーム探索(8 + P2) | 領域の取り違えが原因という記録がない |
| 事実やメモリの Noul ふるい(7 + 6 + P2) | 別サイトの事実で悪化する差は雑音の範囲。古い事実は対応済み |
| 画像を Jev に送る(25–27) | 対象の失敗がなく、画面の個人情報が送られる範囲も広がる |
| 読み取り専用の自動解除(X1) | 人が承認する設計と逆向き |
| 候補の多段の絞り込みと再ランク(16 + 17 + 20) | 行の読み込みの失敗が先にある |

以前の Noul / Score 再設計案(`docs/jev-noul-score-redesign.md`、このブランチには未収録)はホストのトークン削減が目的です。この調査は完了を優先したので、結論が違います。確信度を使う部分については、2 節の結果を先に考慮してください。

## 6. 手順 1 の結果: `plan_more` の state(2026-11-26、API 呼び出しなし)

現在の main で固定ページを開き、下へ 3 回スクロールしながら、Jev に渡る state(`modelState`)に「Scroll down for more plans.」などの状態表示があるかを調べました(付録 B)。

| 指定 | 開始時 | スクロール 1・2 回後 | ページ末尾(3 回目) |
| - | - | - | - |
| `--read table` | なし | なし | 直後の「Loading more plans…」だけ。20 行になった後はなし |
| `--read table --read text` | **あり** | **あり** | あり(読み込み中は画面内の本文に出る) |
| `--read` なし | なし | なし | 直後の「Loading more plans…」だけ |

- `--read table` の見出しは「(11 rows)」(見出し行を含む)です。表がそこで終わりかどうかを示すものは、state にありません。
- 8 回 × 2 条件の過去の A/B ログ(16 実行)では、スクロールなしで確定が 4、1 回が 11、2 回が 1 でした。**行が増える末尾まで届いた実行はありません。**
- 「下に行くと増える」という情報は GOAL には書かれています。state の表と、`page.read` を証拠にしてよいという規則から、表が全部だと扱っていると推測します。Jev の内部の理由は確認していません。
- `--read` なしでは過去に成功した実行があるので、手がかりがなくてもスクロールすることはあります。

**判断**: 情報がないので、Noul の追加(案 A)は後回しです。まず、手がかりを state に入れると選び方が変わるかを確かめます。コードの変更が要らない比較があります。

- A: `--read table`、B: `--read table --read text`。`plan_more` を各 8 回、成功判定は `verify()`。変えるのは `--read` の指定だけです。
- B は状態表示以外の本文も増えるので、差が出ても「状態表示だけの効果」とは言えません。
- B で改善すれば、表や一覧の直後の状態表示(このページは `role="status"`)を読み取りに含めるコード修正を検討します。改善しなければ、情報があっても選べないので、案 A の Noul を固定ページで測ります。
- 状態表示を出さないサイトには、この修正は効きません。

## 7. 手順 2 の結果: 手がかりを渡しても直らない(2026-11-26、実 Jev)

main 011b359、`plan_more`、ホストなしの固定コマンド、各 8 回を交互に実行。実行前に「B の成功が A より 4 回以上多ければ改善」と決めました。記録は `~/webhand-ab/read-text/` です。

| 条件 | `verify()` 成功 | 確定前にスクロールした実行 | 選んだ行 |
| - | - | - | - |
| A: `--read table` | 0/8 | 6/8(各 1 回) | すべて Garnet(正解は Tuff) |
| B: `--read table --read text` | 0/8 | **0/8** | すべて Garnet |

- **改善なし。** B は手がかりが state にあっても(本文の読み取り 1656/1656 文字、切り捨てなし。手順 1 と事前確認で確認)、1 回もスクロールせずに確定しました。
- B でスクロールが減ったのは事後に見た差です。読み取りが増えるほど「全部見えている」と扱う可能性はありますが、推測です。
- 6 節の「情報がないことが原因」という見方は、少なくともそれだけでは説明になりません。**表の直後の状態表示を含めるコード修正は見送ります。**

## 8. 手順 3 の結果: `--read` を外すと末尾までスクロールするが、読み込み中に確定する(2026-11-26、実 Jev)

main 011b359、7 節と同じ手順で各 8 回。判定基準も同じ(B の成功が A より 4 回以上多ければ改善)。記録は `~/webhand-ab/read-none/` です。

| 条件 | `verify()` 成功 | 確定前の `SCROLL_DOWN` | 確定時の状況 | 選んだ行 |
| - | - | - | - | - |
| A: `--read table` | 0/8 | 8/8 が 1 回 | 表は画面より下(10 行) | すべて Garnet |
| B: `--read` なし | 0/8 | 8/8 が 3 回(うち 3 実行は上にも 1 回) | 表は画面内(10 行)、**次の行を読み込み中** | すべて Garnet |

- **改善なし。** `--read` を外せば足りる、という案は採りません。
- B の 8/8 で、確定時の本文の文字数は 2153(開始時 2161)でした。差の 8 文字は、状態表示が「Scroll down for more plans.」(27 文字)から「Loading more plans…」(19 文字)に変わった長さと一致します。表の文字数は 10 行のままです。確定した後に行が増えています。
- 同じ時点を再現した 6 節の確認では、「Loading more plans…」は Jev に渡る本文に入ります。**したがって Jev は、読み込み中の表示がある状態で、待たずに行を確定したと考えられます。** 実行時の state 本体はログに残らないので、文字数からの推定です。
- 読み込みは 400ms です。観測がその間に終わり、確定が行われました。待って 20 行が見えた場合に、40 行目まで進むかは分かりません。

## 9. 手順 4 の結果: 静止の待ち時間を伸ばすと、読み込み後の行が観測できる(2026-11-26、API 呼び出しなし)

`observe` の前の待ちは、DOM の変更が **150ms** 途切れたら終わります(上限 2,000ms、`src/browser/scripts/settle.ts`)。固定ページの読み込みは 400ms のタイマーで、その間は DOM が変わらないため、読み込み中に観測が終わります。通信も `aria-busy` もないので、このページではそれらの信号で検出できません。

テスト用の環境変数 `WEBHAND_SETTLE_QUIET_MS` で待ちを変え、下スクロールと観測だけを繰り返しました(付録 C)。

| 待ち | 3 回目のスクロール後 | 以後のスクロール | 観測 1 回の時間 |
| - | - | - | - |
| 150ms(既定) | 10 行、読み込み中の表示 | (そこで下端) | 約 160–190ms |
| 300ms | 10 行、読み込み中の表示 | (そこで下端) | 約 310ms |
| 450ms | **20 行** | 30 行、**40 行(全件)** | 約 470ms、読み込みを待つ回は約 870ms |
| 600ms | **20 行** | 30 行、**40 行(全件)** | 約 620ms、読み込みを待つ回は約 1,020ms |

- 待ちが読み込み時間(400ms)より長ければ、読み込み中の観測はなくなります。
- **確認していないこと**: Jev が 20 行を見て次へスクロールするかは分かりません。確定するなら、結果は変わりません。
- 全部の観測を長く待つと、毎回約 300ms 遅くなります。製品に入れるなら、**スクロールの直後だけ長く待つ**形が候補です。
- 読み込みが待ちより長いページ(通信を伴う実サイトに多いと推測)は、この方法では拾えません。実サイトでは通信中かどうかの検出が別に要りますが、この固定ページでは試せません。
- `--read table` の確定は下端に届く前なので、この修正の対象外です。

## 10. 手順 5 の結果: 読み込み後の 20 行を見ても確定する(2026-11-26、実 Jev)

main 011b359、`--read` なし、各 8 回。判定基準は 7・8 節と同じです。記録は `~/webhand-ab/settle/` です。

| 条件 | `verify()` 成功 | 確定時の表 | 選んだ行 |
| - | - | - | - |
| A: 待ち 150ms | 0/8 | 10 行(読み込み中) | すべて Garnet |
| B: `WEBHAND_SETTLE_QUIET_MS=600` | 0/8 | **20 行(読み込み後)** | すべて Garnet |

- **改善なし。** 読み込み中の確定はなくなりましたが、Jev は次へスクロールせずに確定しました。待ちを伸ばす実装は見送ります。
- B の確定時、状態表示「Scroll down for more plans.」は画面外へ移り、本文に含まれていなかったと推測します(6 節と同じ手順のオフライン確認による)。待ちと手がかりの両方がそろう条件は試していません。

## 11. 訂正: `plan_more` には `--compare` がある

**この 3 回の比較(計 48 実行)の対象設定は、不適切でした。** 始める前に過去の成功例を確認すべきでした。

- スキルは「一覧から条件で 1 件を選ぶときは `--compare`」「一覧を見終える前に Jev が選んだら `--compare` を付ける」と指示しています(`skills/webhand/SKILL.md`)。`--compare` は Jev が動く前に、読み込みで増える行を含めて一覧全体をスクロールします。
- 手元のログの `plan_more` の成功 31 実行のうち、16 は比較のスキャンを使っています(うち v2 は 2026-11-20 の 1 実行)。残り 15 は 2026-11-06 の旧フローでスキャンなしです。
- 6–10 節の条件はすべて `--compare` なしです。示されたのは「素のループは、増える一覧の最安値を選べない」ことで、製品としての未解決の失敗ではありません。
- 現在の main で `--compare` が成功するかは、この調査では実行していません。
- **案 A の最初の対象はなくなります。** 見込みは「中」から「低」に下げます。対象にできる観測済みの失敗が見つかるまで進めません。

## 12. 進める順

1. ~~手順 1–5~~(完了。6–10 節)
2. クックブックを元にした実装は、今は始めません。
3. 次に調べるなら `collect_*` の失敗です。まず、どの指定で失敗したかをログで確認し(API なし)、スキルどおりの指定で残る失敗だけを対象にします。

## 付録 A: 2 節の分析スクリプト

`python3 -I` で実行します。ログの場所は冒頭の `roots` です。

```python
import json, glob, os, collections
roots = [os.path.expanduser(p) for p in ('~/browser-use/runs','~/webhand-bench','~/webhand-experiments','~/webhand-ab','~/.webhand/state','~/webhand-wt')]
files = set()
for r in roots:
    for d, ds, fs in os.walk(r):
        ds[:] = [x for x in ds if x not in ('node_modules','.git','dist')]
        files.update(os.path.realpath(os.path.join(d,f)) for f in fs if f.endswith('.jsonl'))
seen=set(); runs=[]
for f in sorted(files):
    steps=[]; start=None; end=None; nv=[]
    for l in open(f,errors='ignore'):
        try: e=json.loads(l)
        except: continue
        if not isinstance(e,dict): continue
        t=e.get('type')
        if t=='run_start': start=e
        elif t=='step': steps.append(e)
        elif t=='run_end': end=e
        elif t=='not_visible': nv.append(e)
    if not start: continue
    key=(start.get('started_at'),start.get('task'),start.get('repeat'))
    if key in seen: continue
    seen.add(key); runs.append((f,start,steps,end,nv))
jev=[r for r in runs if any(isinstance(s.get('confidence'),(int,float)) and s.get('decided_by')!='scripted' for s in r[2])]
print('files',len(files),'runs',len(runs),'with jev steps',len(jev))
lab=[r for r in jev if r[3] and isinstance(r[3].get('verified'),bool)]
print('labelled',len(lab),'verified true',sum(r[3]['verified'] for r in lab))
print('task counts (labelled fail)',collections.Counter(r[1].get('task') for r in lab if not r[3]['verified']).most_common(15))
bins=[(0,.5),(.5,.7),(.7,.9),(.9,.99),(.99,1.01)]
def b(c): return next(i for i,(a,z) in enumerate(bins) if a<=c<z)
def C(r): return [s for s in r[2] if isinstance(s.get('confidence'),(int,float)) and s.get('decided_by')!='scripted']
print('\nrun by min confidence: bin n fail%')
for i,(a,z) in enumerate(bins):
    g=[r for r in lab if b(min(s['confidence'] for s in C(r)))==i]
    if g: print((a,z),len(g),round(100*sum(not r[3]['verified'] for r in g)/len(g)))
print('\nstep level: bin steps in-failed-run% no-change%')
S=[(s,r) for r in lab for s in C(r)]
for i,(a,z) in enumerate(bins):
    g=[x for x in S if b(x[0]['confidence'])==i]
    if g: print((a,z),len(g),round(100*sum(not r[3]['verified'] for s,r in g)/len(g)))
print('\nwithin task (tasks having both): min conf mean ok vs fail')
by=collections.defaultdict(lambda:([],[]))
for r in lab: by[r[1].get('task')][0 if r[3]['verified'] else 1].append(min(s['confidence'] for s in C(r)))
w=l=t=0
for k,(o,f) in sorted(by.items()):
    if len(o)>=3 and len(f)>=3:
        print(k,len(o),round(sum(o)/len(o),2),len(f),round(sum(f)/len(f),2))
        for x in f:
            for y in o:
                w+=x<y; l+=x>y; t+=x==y
if w+l+t: print('within-task AUC(fail has lower min conf)',round((w+.5*t)/(w+l+t),3),'pairs',w+l+t)
ok=[r for r in lab if r[3]['verified']]
for th in (.5,.7,.9):
    print('gate',th,'would stop ok runs',round(100*sum(any(s['confidence']<th for s in C(r)) for r in ok)/len(ok)),'% / fail runs',round(100*sum(any(s['confidence']<th for s in C(r)) for r in lab if not r[3]['verified'])/max(1,len(lab)-len(ok))),'%')
fails=[r for r in lab if not r[3]['verified']]
print('fail outcomes',collections.Counter(r[3].get('outcome') for r in fails).most_common())

print('\n--- within-task AUC variants (share of ok/fail pairs where fail is LOWER)')
import statistics as st
def auc(feat):
    by=collections.defaultdict(lambda:([],[]))
    for r in lab:
        v=feat(C(r))
        if v is not None: by[r[1].get('task')][0 if r[3]['verified'] else 1].append(v)
    w=n=0
    for o,f in by.values():
        for x in f:
            for y in o: w+=1 if x<y else .5 if x==y else 0; n+=1
    return (round(w/n,3) if n else None),n
def sub(pred,agg=min):
    return lambda S:(agg([s['confidence'] for s in S if pred(s)]) if any(pred(s) for s in S) else None)
print('mean',auc(sub(lambda s:True,st.mean)))
print('first step',auc(lambda S:S[0]['confidence']))
print('min over first 3',auc(lambda S:min(s['confidence'] for s in S[:3])))
for k in ('click','fill','select'):
    print('min',k,auc(sub(lambda s:s.get('kind')==k)))
print('verified fail run_end keys', collections.Counter(tuple(sorted(r[3])) for r in fails).most_common(3))
print('models', collections.Counter(str((r[1].get('config') or {}).get('model')) for r in lab).most_common(5))

print('\nper task mean-conf AUC')
by=collections.defaultdict(lambda:([],[]))
for r in lab:
    S=C(r); by[r[1].get('task')][0 if r[3]['verified'] else 1].append((st.mean(s['confidence'] for s in S),len(S)))
for k,(o,f) in sorted(by.items()):
    if len(o)>=3 and len(f)>=3:
        print(k,'ok n=%d conf=%.2f steps=%.1f'%(len(o),st.mean(a for a,_ in o),st.mean(b for _,b in o)),'| fail n=%d conf=%.2f steps=%.1f'%(len(f),st.mean(a for a,_ in f),st.mean(b for _,b in f)))
print('step count AUC (fail has fewer steps)',auc(lambda S:len(S)))
print('kinds',collections.Counter(s.get('kind') for r in lab for s in C(r)))

print('\ngates on mutating steps only')
for th in (.1,.2,.3,.5):
    def hit(r): return any(s.get('kind') in('click','fill','select') and s['confidence']<th for s in C(r))
    f=[r for r in lab if not r[3]['verified']]
    print(th,'ok runs stopped %d%% fail runs stopped %d%%'%(round(100*sum(map(hit,ok))/len(ok)),round(100*sum(map(hit,f))/len(f))))
```

## 付録 B: 6 節の state 確認スクリプト

`--read table --read text` と指定なしは、`view` の `read` を変えて実行します。

```ts
// Offline probe: what Jev would receive on plan_more. No network, no Jev call.
const R = `${process.env.HOME}/browser-use`;
const { Browser } = await import(`${R}/src/browser/index.ts`);
const { modelState } = await import(`${R}/src/policies/base.ts`);
const url = `file://${R}/tasks/fixtures/plans_more.html`;
const browser = await Browser.open(url, { view: { read: ["table"], whole: true }, rememberTab: false });
const dom = "JSON.stringify({rows: document.getElementById('plans').rows.length - 1, status: document.getElementById('more').textContent, y: Math.round(scrollY)})";
const show = async (label: string, full = false) => {
  const page = await browser.observe();
  const s = JSON.stringify(modelState(page, []));
  const p = modelState(page, []).page as any;
  console.log(`== ${label} dom=${await browser.evaluate(dom)}`);
  console.log("cue in page.text:", /Scroll down for more|Loading more|All plans are shown/.exec(p.text)?.[0] ?? null,
    "| in read:", /Scroll down for more|Loading more|All plans are shown/.exec(p.read?.text ?? "")?.[0] ?? null,
    "| anywhere in state:", /Scroll down for more|Loading more|All plans are shown/.exec(s)?.[0] ?? null);
  console.log("offscreen:", JSON.stringify(p.offscreen), "chars", s.length);
  console.log("read table header:", (p.read?.text ?? "").split("\n").filter((l: string) => l.startsWith("## table")).join(" / "));
  if (full) { console.log("--- page.text"); console.log(p.text); console.log("--- read"); console.log(p.read?.text); }
  return page;
};
let page = await show("start", true);
for (let i = 1; i <= 3; i++) {
  const down = page.actions.find((a: any) => a.kind === "scroll" && /down/i.test(a.label));
  if (!down) { console.log("no scroll down action"); break; }
  await browser.act(down, page);
  await show(`after scroll ${i}, immediately`, i === 1);
  await new Promise((r) => setTimeout(r, 1000));
  page = await show(`after scroll ${i}, +1s`);
}
await browser.close();
```

## 付録 C: 9 節の確認スクリプト

```ts
// Offline: does a longer settle quiet window let observe() see the loaded rows? No Jev call.
const R = `${process.env.HOME}/browser-use`;
const { Browser } = await import(`${R}/src/browser/index.ts`);
const { modelState } = await import(`${R}/src/policies/base.ts`);
const browser = await Browser.open(`file://${R}/tasks/fixtures/plans_more.html`, { view: { whole: true }, rememberTab: false });
let page = await browser.observe();
const out: string[] = [];
for (let i = 1; i <= 12; i++) {
  const down = page.actions.find((a: any) => a.kind === "scroll" && /down/i.test(a.label));
  if (!down) { out.push("end"); break; }
  const t = performance.now();
  await browser.act(down, page);
  page = await browser.observe();
  const s = JSON.stringify(modelState(page, []));
  const rows = await browser.evaluate("document.getElementById('plans').rows.length - 1");
  out.push(`s${i}:rows=${rows}${s.includes("Loading more") ? "(LOADING)" : ""}${s.includes("All plans are shown") ? "(ALL)" : ""} ${Math.round(performance.now() - t)}ms`);
}
console.log(out.join(" | "));
await browser.close();
```
