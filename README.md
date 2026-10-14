# dsh-media-gen

DeepSeek Harness（DSH）向けの画像・動画生成プラグインです。DSH に設定済みのプロバイダーと認証情報をそのまま使い、API キーを二重に登録させません。

- 方針：[docs/policy.md](docs/policy.md)
- 段階0 接続調査：[docs/investigation.md](docs/investigation.md)

## 現在の状態（段階1：画像 MVP）

- OpenRouter の Image API（`/images/models`、`/images`）による画像生成。
- 動画生成（段階2）、チャット内の専用カード UI（クライアント側）は未実装です。
- **DSH 実機と OpenRouter 実通信での動作は未検証**です。単体テストはモック通信で行っています。

## インストール

```sh
pnpm install && pnpm build
dsh plugin --profile <profile> add /path/to/dsh-media-gen
```

対象 DSH：`0.2.1-alpha.2`（`@deepseek-ai/dsh-*` の peerDependencies で照合されます）。

## 前提

DSH の Models 設定で OpenRouter のプロバイダーを追加し、API キーを保存しておきます。ルート名が `openrouter`、または Base URL のホストが `openrouter.ai` のプロバイダーを画像生成に使います。

## ツール

| ツール | 内容 |
|---|---|
| `media_list_models` | 設定済みプロバイダーの画像モデルと、各モデルが受け付けるパラメーターを一覧します |
| `media_generate_image` | 画像を生成し、作業ディレクトリの `generated-media/` に保存して添付として表示します |

## 設定

| 項目 | 既定値 | 内容 |
|---|---|---|
| `defaultImageProvider` | なし | 既定の DSH プロバイダー ID |
| `defaultImageModel` | なし | 既定の画像モデル ID |
| `maxImagesPerCall` | 4 | 1 回あたりの最大枚数 |
| `requireApproval` | true | 生成のたびに、概算料金つきで承認を求めます |
| `outputDir` | `generated-media` | 保存先（作業ディレクトリからの相対パス） |
| `catalogTtlMs` | 600000 | モデル一覧のキャッシュ期間 |
| `requestTimeoutMs` | 180000 | プロバイダー呼び出しのタイムアウト |
| `maxImageBytes` | 31457280 | 受け付ける画像の最大サイズ |

## 言語

承認ダイアログとプラグイン名は英語と日本語に対応しています。DSH の言語が `ja` のとき日本語、それ以外は英語で表示します。モデルに渡すツール説明は、DSH の仕様上英語固定です。

## 開発

```sh
pnpm typecheck
pnpm test
```
