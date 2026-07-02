# cogsync 使い方ガイド

> Claude Code を一日中使う人向け。cogsync は「AI の利用制限（5 時間ごとの枠・週次の枠）」と
> 「自分の集中サイクル」を見張って、**いま何をすべきか**を教えてくれる小さな相棒です。
> AI を呼んだり勝手に何かを実行したりはしません。観測して助言するだけ（＝安全）。

一番効く一言だけ先に: **「木曜に枠が尽きて仕事が止まる」を火曜に予報し、夜間の自動処理が
日中の対話の枠を食い尽くすのを止める。** それが cogsync の核心です。

---

## 0. まず全体像（3 つだけ覚える）

cogsync は 3 種類の使い方があります。難しく考えず、上から順に足していけば OK。

1. **見せる（statusLine）**: Claude Code の一番下の行に「枠の残り」を出す。設定 1 回で放置。
2. **聞く（コマンド）**: 節目で `cogsync 〇〇` と打つと、待つ/切る/走らせる を教えてくれる。
3. **見張らせる（watch 常駐）**: 裏で回しておくと、閾値を超えた時だけ通知が来る。

観測の素は Claude Code が出す「rate_limits（5h と週次の使用率）」です。だから **まず 1 番
（statusLine 連携）をやると、他の全機能が動き出します**。逆に言うと、statusLine 連携をしないと
多くのコマンドは `unknown`（＝まだ観測できていない）を返します。

---

## 1. 5 分セットアップ

### 1-1. インストール

```bash
npm install -g cogsync-cli@alpha
cogsync --version     # 1.0.0-alpha.3 などが出れば OK
```

（Node.js 20 以上が必要。`ccusage` は使う機能もありますが、下記の主要機能は不要です。）

### 1-2. statusLine 連携（これが土台。まずこれだけやる）

Claude Code は画面下の statusLine に、あなたのコマンドを毎メッセージ呼び出します。そこに
`cogsync statusline` を挟むと、5h/週次の使用率が cogsync に流れて保存されます（表示も 1 行返す）。

`~/.claude/settings.json` に次を足す（既に statusLine がある人は下の「合わせ技」を参照）:

```json
{
  "statusLine": { "type": "command", "command": "cogsync statusline" }
}
```

これで画面下に `cogsync 5h 62% | 週次green -22.0pt` のような行が出ます。読み方:

- `5h 62%` … 今の 5 時間枠を 62% 使った
- `週次green -22.0pt` … 週次の消費が「均等に使った場合の予算線」より 22 ポイント下（余裕）。
  `green`=余裕 / `yellow`=予算線を超えた / `red`=大きく超過（木曜飢饉が近い）

> **合わせ技**: 既に自作の statusLine を使っている人は、その中で `cogsync statusline` を
> バックグラウンド実行すれば、表示は今のまま・観測だけ裏で貯まります。例:
> `printf '%s' "$input" | cogsync statusline >/dev/null 2>&1 &`
> （実際にこの方法で組み込んだ例が cogsync repo の `scripts/statusline.sh`）

### 1-3. 設定ファイル（任意。既定のままでも動く）

`~/.config/cogsync/config.yaml` を置くと既定値を上書きできます。最初は不要。
よく触るのはこの辺（数字は既定値）:

```yaml
thresholds:
  reservePhi: 0.3          # 夜間バッチ用に「5h 枠の 30% は在席用に残す」ライン
  weeklyRedMarginPct: 14.3 # 週次が予算線を +14.3pt 超えたら red（≒1 日分の前借り）
notify:
  deferDuringPhases: [design, implement]  # この間は通知を境界まで我慢する
  maxDeferMin: 60          # ただし 60 分を超えたら我慢をやめて通知する
```

`cogsync config` で「今どう解決されているか」を確認できます。

### 1-4. MCP 登録（任意。上級者向け）

cogsync を MCP サーバとして登録すると、Claude 自身が「今フェーズ何？」「バッチ走らせていい？」を
問い合わせられます。`~/.claude/settings.json` などに:

```json
{ "mcpServers": { "cogsync": { "command": "cogsync", "args": ["mcp"] } } }
```

（普段使いには不要。まずは CLI で慣れてからで OK。）

---

## 2. 毎日の使い方（時系列で覚える）

「いつ・どのコマンドを打つか」を一日の流れに沿って並べます。全部やる必要はなく、効くところだけ。

### 朝いちばん（今日どれくらい枠に余裕がある？）

```bash
cogsync status
```

5h 窓の残りと、週次ペース（予算線からの乖離）が出ます。`週次 red` なら「今週は前借りしすぎ、
今日は重い自動処理を控える日」というサイン。

### 集中作業に入る前（今フェーズを宣言しておく）

```bash
cogsync phase set implement    # design / implement / review / break
```

これを宣言しておくと、後述の「通知の繰延（deep 中は割り込まない）」が効きます。宣言しないと
通知はすべて即時（従来どおり）。

### 深い設計を始める直前（窓を開き直すべき？）

```bash
cogsync suggest-priming --deep-duration 120   # これから 120 分集中する想定
```

- `no_priming_needed` … そのまま始めて OK
- `wait_for_reset` … 今の 5h 窓が消費済みで、セッション後までリセットしない。**リセットまで
  少し待って新しい窓で始める**か、低予算セッションを受け入れる、という助言（アクティブな窓は
  前倒しリセットできないため）

### 枠が尽きた／尽きそう（待つ？別の AI に移す？）

```bash
cogsync should-i-handoff --value 50    # このタスクの価値を 50 とみなして判定
```

- `wait` … もうすぐ補充される。待つのが得
- `handoff` … 補充が遠い。副系（別ベンダの同格モデル等）へ移す方が得。移すなら
  `cogsync handoff` で引き継ぎプロンプトを作れます（下記）

### AI が長く処理している間（引き継ぎメモを作る）

```bash
cogsync handoff --title 認証まわり --goal "JWT を分離" --next "Cookie 経路を切り出す"
```

Goal / State / Decisions / Open Questions / Next Action の雛形を作ってクリップボードに入れます。
（このメモの質が良いほど、上の should-i-handoff で「移す」が有利になります＝移行コストが下がる）

### 夜の自動処理・cron（枠を食い尽くさないよう自主規制）

これが cogsync の目玉。cron や自作の夜間バッチの前に 1 行足すだけ:

```bash
cogsync can-i-run-batch && ./nightly-batch.sh
```

`can-i-run-batch` は exit 0（allow）/ 1（hold）を返すので、`&&` でそのままゲートになります。

- 5h の残りが在席リザーブ（既定 30%）を割る → hold（走らせない）
- 週次が red → hold（今週はもう枠がない）
- バッチの消費見込みを渡すこともできる: `cogsync can-i-run-batch --estimated-usage-pct 40`

これで「夜のうちに週次枠を使い切って、翌朝の対話が枠切れ」を防げます。

### 一日中ぼんやり見張らせたい（常駐）

```bash
cogsync watch     # Ctrl-C で終了。--once で 1 回だけ動作確認
```

裏でポーリングして、雪だるま（会話が膨れすぎ）・枠接近・週次超過などを検知した時**だけ**
デスクトップ通知します。`phase set implement` 済みなら、集中中の非緊急通知は境界まで我慢して
まとめて 1 通で届きます（うるさくしない）。

---

## 3. コマンド逆引き（何をしたい時にどれ）

| やりたいこと | コマンド | 返るもの |
| --- | --- | --- |
| 今の枠残量を見たい | `cogsync status [--json]` | 5h 残・週次ペース・繰延保留件数 |
| 画面下に常時表示したい | `cogsync statusline`（settings に登録） | 1 行（5h%・週次±pt） |
| 夜間バッチを自主規制したい | `cogsync can-i-run-batch [--estimated-usage-pct N]` | **exit 0=allow/1=hold** |
| 待つか別 AI に移すか迷う | `cogsync should-i-handoff [--value N]` | wait / handoff |
| 集中前に窓を開き直すべきか | `cogsync suggest-priming [--deep-duration N]` | no_priming_needed / wait_for_reset |
| 引き継ぎメモを作りたい | `cogsync handoff --goal … --next …` | 雛形＋クリップボード |
| フェーズを宣言したい | `cogsync phase set implement` | 現/新フェーズ |
| 裏で見張らせたい | `cogsync watch [--once]` | 常駐＋通知 |
| ポモドーロを回したい | `cogsync pomodoro start [--focus 25] [--break 5]` | 適応タイマー |
| 並列いくつが安全か知りたい | `cogsync skill` | 過去ログからの推奨並列数 |
| 設定を確認したい | `cogsync config` | 解決後の設定 JSON |
| Claude から状態を読ませたい | `cogsync mcp`（MCP 登録） | MCP サーバ |

`--json` を付けられるコマンドは機械可読 JSON を返すので、自作スクリプトから消費できます。

---

## 4. 設定キー早見（config.yaml）

| キー | 既定 | 意味 |
| --- | --- | --- |
| `thresholds.reservePhi` | 0.3 | 夜間バッチが 5h 枠を食ってよい下限（残り 30% は在席用に確保） |
| `thresholds.reserveGateOnUnknown` | allow | 5h が観測できない時 can-i-run-batch を通すか（deny で止める側） |
| `thresholds.weeklyRedMarginPct` | 14.3 | 週次が予算線を何 pt 超えたら red か（≒1 日分） |
| `thresholds.weeklySnapshotStaleMin` | 60 | 観測データが何分古くなったら「信用しない（stale）」か |
| `thresholds.handoffReconstructCost` | 20 | ハンドオフの固定コスト h（should-i-handoff の閾値） |
| `thresholds.handoffSecondaryQuality` | 0.9 | 副系の品質 q'（1 なら同格） |
| `thresholds.primeIfUsedPct` | 50 | 5h をこれ以上使っていたら「もう新しくない」とみなす |
| `notify.deferDuringPhases` | design, implement | この間は通知を境界まで繰延 |
| `notify.maxDeferMin` | 60 | 繰延の安全弁（これを超えたら我慢をやめる） |
| `profile.dailyDeepWorkCapMin` | 240 | 1 日のディープワーク上限（分）。超えたら休憩推奨 |

---

## 5. 困ったとき

- **コマンドがいつも `unknown` を返す** → statusLine 連携（1-2）がまだ。まず設定して、Claude Code で
  数メッセージ会話すると観測が貯まります。`cogsync status` に 5h/週次が出れば OK。
- **通知が来ない** → (a) `cogsync watch` を起動しているか、(b) 集中フェーズ中は繰延で溜まっている
  かも（`cogsync status` の「繰延通知 N 件保留中」を確認）、(c) 閾値を超えていないだけ（正常）。
- **`suggest-priming` がいつも wait_for_reset** → アクティブな 5h 窓が消費済みでリセットが先、の状態。
  cogsync は AI を呼べないので実際の「窓開け ping」は自分か Anthropic の Routines で送る前提です。
- **`can-i-run-batch` が常に hold** → 週次が red か 5h 残が薄い。`cogsync status` で内訳を確認。
  statusLine 未設定なら `reserveGateOnUnknown: allow`（既定）で通るはず。deny にしていないか確認。
- **画面下の表示が出ない/壊れる** → statusLine スクリプトは「失敗しても固定文字列 `cogsync` を返して
  exit 0」する設計なので Claude Code は壊れません。表示が `cogsync` だけなら観測データがまだ無い状態。

---

## 6. 背景（もっと知りたい人へ）

cogsync の助言は思いつきではなく、AI 利用制限を数理モデル化した調査 repo（`cogsync`）の
形式モデル §8 と実験 §9 に基づきます。各コマンドと理論の対応:

| コマンド | 根拠 |
| --- | --- |
| status / statusline（週次 pacing） | §9 E1（木曜飢饉）・「飢餓は消せないので配置する」 |
| watch の通知繰延 | §9 E5（deep 中の割り込みを 0 に） |
| can-i-run-batch（リザーブ） | §8.7 P1 reserve(φ)・§9 E3/E6 |
| should-i-handoff | §8.8 命題4（待ち費用 vs 移行費用の閾値則） |
| suggest-priming | §8.2 命題2・§9 E2（アンカー・プライミング） |

詳細は [`README.md`](../README.md) と調査 repo を参照。
