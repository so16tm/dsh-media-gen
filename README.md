# dsh-media-gen

DeepSeek Harness（DSH）向けの画像・動画生成プラグインです。DSH に設定済みのプロバイダーと認証情報をそのまま使い、API キーを二重に登録させません。

- 方針：[docs/policy.md](docs/policy.md)
- 段階0 接続調査：[docs/investigation.md](docs/investigation.md)

## 現在の状態（段階2：動画 MVP）

- 画像：OpenRouter の Image API（`/images/models`、`/images`）で生成します。DSH 0.2.0-rc.2（Windows）の実機で、実通信による生成を確認済みです。
- 動画：OpenRouter の Video API（`/videos/models`、`/videos`）にジョブを登録し、裏で状態を確認して、完成したら作業ディレクトリに保存してセッションに知らせます。**DSH 実機と実通信での動作は未検証**です。
- 単体テストはモック通信で行っています。
- DSH の Web UI では、ツール結果の画像はプレビューされず JSON として表示されます。保存先のファイルを開いて確認してください。チャット内の専用カード UI（クライアント側）は未実装です。

## インストール

```sh
pnpm install && pnpm build
dsh plugin --profile <profile> add /path/to/dsh-media-gen
```

対象 DSH：`0.2.0-rc.2` 以上 `0.3.0` 未満（`@deepseek-ai/dsh-*` の peerDependencies で照合されます）。開発と型チェックは `0.2.0-rc.2` の公開パッケージで行っています。

## 前提

DSH の Models 設定で OpenRouter のプロバイダーを追加し、API キーを保存しておきます。ルート名が `openrouter`、または Base URL のホストが `openrouter.ai` のプロバイダーを画像生成に使います。

## ツール

| ツール | 内容 |
|---|---|
| `media_list_models` | 設定済みプロバイダーの画像モデル（`kind: "video"` なら動画モデル）と、各モデルが受け付けるパラメーターを一覧します |
| `media_generate_image` | 画像を生成し、作業ディレクトリの `generated-media/` に保存して添付として表示します |
| `media_generate_video` | 動画の生成ジョブを登録し、すぐにジョブ ID を返します。完成すると `generated-media/` に保存し、セッションに知らせます |
| `media_video_status` | 動画ジョブの一覧を表示します。`job_id` を渡すと、その場でプロバイダーに状態を確認します |

## 動画ジョブ

- 登録したジョブは DSH のストレージ（storage domain）に記録します。DSH を再起動しても、未完了のジョブの確認を再開します。ストレージが使えない環境ではメモリーにだけ記録し、再起動すると追跡できなくなります。
- `videoPollIntervalMs` ごとに状態を確認し、完成したらすぐに動画をダウンロードします。OpenRouter 側の保持期間は公開されていないためです。
- 完成・失敗・期限切れは、ジョブを登録したセッションに知らせます。セッションが閉じていたら、次にそのセッションを開いたときに知らせます。
- `videoMaxWatchMs` を過ぎても終わらないジョブは、確認を止めて「停止」と表示します。OpenRouter には取り消しの API がないため、これはジョブの取り消しではありません。`media_video_status` に `job_id` を渡すと確認を再開します。
- 生成前の承認ダイアログには、モデル一覧の `pricing_skus` から求めた概算料金を出します。秒単位の料金なら秒数を掛け、解像度や長さが決まらないときは幅で示します。料金の形式を読み取れないときは「不明」と表示します。

## 設定

| 項目 | 既定値 | 内容 |
|---|---|---|
| `defaultImageProvider` | なし | 既定の DSH プロバイダー ID |
| `defaultImageModel` | なし | 既定の画像モデル ID |
| `maxImagesPerCall` | 4 | 1 回あたりの最大枚数 |
| `defaultVideoProvider` | なし | 動画生成に使う既定の DSH プロバイダー ID |
| `defaultVideoModel` | なし | 既定の動画モデル ID |
| `maxVideoSeconds` | 10 | 1 回あたりの動画の最大秒数 |
| `requireApproval` | true | 生成のたびに、概算料金つきで承認を求めます |
| `outputDir` | `generated-media` | 保存先（作業ディレクトリからの相対パス） |
| `catalogTtlMs` | 600000 | モデル一覧のキャッシュ期間 |
| `requestTimeoutMs` | 180000 | プロバイダー呼び出しのタイムアウト |
| `maxImageBytes` | 31457280 | 受け付ける画像の最大サイズ |
| `videoPollIntervalMs` | 30000 | 動画ジョブの状態を確認する間隔 |
| `videoMaxWatchMs` | 10800000 | 動画ジョブの確認を続ける時間（3 時間） |
| `maxVideoBytes` | 524288000 | 受け付ける動画の最大サイズ |
| `notifyOnVideoCompletion` | true | 動画ジョブが終わったらセッションに知らせます |

## 言語

承認ダイアログ（画像・動画）とプラグイン名は英語と日本語に対応しています。DSH の言語が `ja` のとき日本語、それ以外は英語で表示します。モデルに渡すツール説明と、動画ジョブの完了通知の本文は英語です。完了通知はモデルが読み、ユーザーの言語で返答します。

## 開発

```sh
pnpm typecheck
pnpm test
```
