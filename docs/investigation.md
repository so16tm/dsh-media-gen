# 段階0 接続調査メモ

> 調査日：2026-10-14  
> 対象：DeepSeek Harness `deepseek-ai/deepseek-harness` master（commit `d743267`、`0.2.1-alpha.2`）、OpenRouter 公式ドキュメント  
> 方針書：[`docs/policy.md`](./policy.md)（v1.1）  
> パスは DSH リポジトリのルートからの相対パス。「推測」と書いた箇所は未検証。

## 1. 結論

方針書の設計は **おおむねそのまま実現できる**。ただし次の 4 点は方針書の想定と違うため、段階1の前に設計へ反映する。

1. **DSH 本体に日本語はない。** 同梱ロケールは `zh` と `en` だけ。ロケール ID も `ja-JP` ではなく `ja` 形式。日本語にするには、プラグインが DSH に「日本語」言語パックを登録する必要がある（§4）。
2. **プロバイダーの baseURL と接続方式を返す専用 API はない。** `ctx.llm` は ID と名前しか返さない。設定サービス経由でプロファイルを読む方式になる（§2）。
3. **動画は attachment の対象外。** 画像は既存の添付・画像ギャラリーに乗るが、動画は保存と表示を自前で用意する（§5）。
4. **jobs サービスは再起動で消える。** 動画ジョブの永続化は `storage-domain` で自前実装し、再開と通知は `schedule` パッケージの方式をまねる（§6）。

## 2. プロバイダー設定の共有（方針書 §4）

| 項目 | 結果 | 根拠 |
|---|---|---|
| プロバイダー一覧 | `ctx.llm.listProviders()` は `{id, name}` のみ。`listConfigurableProviders()` は `{provider, displayName, settingsNs, settingsPath}` を返す | `packages/llm/llm/src/index.ts:470-473, 542-545` |
| OpenRouter の表現 | **専用アダプターはない**。`llm-pi-ai` の汎用プロファイル（ルートキー `openrouter`、`api: 'openai-completions'`） | `packages/llm/llm-pi-ai/tests/config.spec.ts:25` |
| baseURL / 接続方式 | `llm-pi-ai` のプロファイル `{apiKeyEnv, api, baseURL}` の中にしかない。`settingsNs` + `settingsPath`（例 `['providers','openrouter']`）で `ctx.settings.describe()` から読める（**推測、要実機確認**） | `llm-pi-ai/src/config.ts:92-104`、`src/index.ts:131-135`、`settings/settings/src/index.ts:302-338` |
| 秘密値の取得 | プロファイルの `apiKeyEnv`（CredentialRef）を `ctx.credentials.resolve(ref)` で解決。**キャッシュ禁止、毎回 resolve** | `credentials/credentials/src/index.ts:277-284`、手本は `llm-pi-ai/src/index.ts:186-204` |
| 変更通知 | `llm/adapters-updated`、`settings/document-updated`、`credentials/reference-updated` | `llm/llm/src/types.ts:12-24` ほか |
| 生成 API の既存サポート | **なし**。llm の出力はテキスト専用で、画像専用モデルはルートから除外される | `llm/llm/src/types.ts:74-77, 452-463`、`llm-pi-ai/src/catalog.ts:168-178` |

**設計への反映**
- `ProviderBridge` は「`listConfigurableProviders` → settings でプロファイルを読む → `credentials.resolve`」の 3 段にする。読み取り箇所はこのクラスに閉じ込め、`llm-pi-ai` の設定形式が変わったときの影響をここだけに限定する。
- 生成リクエストは llm の stream を使わず、自前の HTTP 呼び出しにする。Base URL は `https://openrouter.ai/api/v1` を前提に、プロファイルの baseURL から組み立てる。
- 将来は DSH 本体に「プロバイダー接続情報の参照 API」を提案する余地がある（方針書 §3 の「小さな共通サービス」）。
- 注意：プロセス内のプラグインは任意の CredentialRef を resolve できる（呼び出し元ごとのアクセス制御はない、`credentials/README.md:177`）。本プラグインは、選んだプロバイダーの `apiKeyEnv` 以外を読まない。

## 3. プラグインの構成とツール登録（方針書 §3, §7）

- **エントリ**：`export const name` / `export const inject` / `export const Config = Schema.object(...)` / `export function apply(ctx, config)`（`docs/user/develop/basic/index.md:17-27`、`config.md:19-45`）。
- **配布**：`package.json` の `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` と patch の `insert` 行（`docs/user/develop/basic/publish.md:35-62`）。`@deepseek-ai/dsh-*` は peerDependencies と devDependencies の両方に書く。読み込み時に peer の範囲がバージョン照合される。
- **インストール**：`dsh plugin add ./pkg | github:u/r#sha | npm名`、または Web の Plugins 画面。
- **最小実例**：`packages/experimental/cot-translation-bundle`（host + client 構成）。
- **ツール登録**：`ctx.tools.register(defineTool({ name, description, parameters, output: {schema, render}, execute, timeoutMs }))`（`docs/cookbook/adding-a-tool.md:9-35`）。
- **ツール説明の言語**：モデル向けの `description` は単一文字列で、ローカライズ機構はない。英語固定にする。ユーザー向けの表示はクライアントの `tool.call.toolview` スロットで翻訳する。
- **承認**：`ctx.approval.request()`。`allowed-once` だけを許可として扱う（`interaction/user-approval/src/index.ts:215`）。課金を伴う生成の前確認に使える。
- **実行上限**：回数やレートを制限する汎用機構はない。上限は本プラグインの Config で持つ。
- **設定画面**：Config スキーマからフォームは自動生成されない（`settings/settings/README.md:39`）。`plugins.bundle.config` スロットに自前のフォームを登録し、client 側を別にビルドする（`docs/cookbook/adding-a-settings-card.md`）。

## 4. 日本語・英語ロケール（方針書 §8）

| 項目 | 結果 | 根拠 |
|---|---|---|
| ロケール機構 | クライアント側の `ctx.locale` のみ。Host 側は設定値 `locale.preference` を保存するだけ | `packages/client/locale/src/` |
| 同梱言語 | `LOCALE_IDS = ['zh', 'en']`。**日本語なし** | `client/locale/src/locale-settings.ts:47` |
| 現在ロケール・変更通知 | `getSnapshot().active`、イベント `locale/change`、`subscribe()` | `client/locale/src/client/index.ts:74-96, 227-238` |
| 言語の追加 | `ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' })`。追加すると設定画面の言語一覧に出る。同じ ID が既にあると throw | 同 `:275-279` |
| 辞書登録 | `ctx.locale.register(ns, 'en', dict)` / `register(ns, 'ja', dict)`。キーはフラット、`{name}` で差し込み | 同 `:388-423`、実例 `extensions/ui-cordis/src/client/locales.ts` |
| フォールバック | 名前空間内で ja→en、次に `common` 名前空間、最後はキー文字列そのもの | 同 `:466-472` |
| 書式化 | 共通ユーティリティはない。辞書に `'time.locale': 'ja-JP'` を持たせて `Intl` に渡す方式が既存実例 | `client/ui-schedule/src/client/frequency-locales.ts:15` |
| プラグイン名の翻訳 | `locale/en.json`（必須）と `locale/ja.json` に `{"meta": {"title","description"}}` | `boot/app-boot/src/package-meta.ts:124-179` |

**設計への反映**
- 内部の言語 ID は DSH の流儀に合わせて `ja` / `en` とする。方針書の `ja-JP` / `en-US` は、`Intl` に渡す書式ロケールとして使う。
- 本プラグインは起動時に `ja` が未登録なら `addLanguage` で登録し、登録済みなら何もしない。辞書は `en` と `ja` を登録し、`zh` は `en` にフォールバックさせる。
- **副作用**：DSH の言語設定に「日本語」が増える。日本語を選ぶと **本プラグインの部分だけが日本語になり、DSH 本体の UI は英語にフォールバックする**。方針書の「本体ロケールに追従」は満たすが、本体全体の日本語化は範囲外（§8 で判断が必要な点）。

## 5. 成果物の保存と表示（方針書 §6, §7）

- **画像**：`ctx.attachments.saveImage({data, mediaType, name})` で保存し、ツール結果に `{type:'image', attachment: ref}` を返すと、既存の画像表示に乗る。参照実装は `fs/tool-fs/src/read-image.ts:191-271`。PNG / JPEG / WebP / GIF に対応し、サイズ上限あり。OpenRouter の応答は Base64 なので、そのままデコードして渡せる。
- **動画**：attachment は動画を扱わない（`attachment/README.md:12`）。サイドバーのプレビューでも mp4 は非対応。案は次の 2 つ。
  - 作業ディレクトリに mp4 を書き、組み込みの `present` ツールで成果物カードとして示す（`deliverables/tool-present/src/index.ts`）。
  - `ctx.documentPreviews.register({extensions: ['mp4','webm'], ...})` で動画プレビューを追加する。
  - 段階2では、まず前者で保存と提示を行い、プレビュー追加は段階3以降にする。
- **バイナリ書き込み**：`ctx.fs` はテキスト書き込みしか持たない。ローカル実行前提で Node の fs を使う（SSH / サンドボックス環境での挙動は未検証）。

## 6. 動画ジョブの永続化と再開（方針書 §6）

- `ctx.jobs` はプロセス内のみで、再起動すると消える（`jobs/jobs/README.md:55, 126`）。
- 永続化には `ctx.storageDomain.open(defineDomain({...}))` を使う（`storage/storage-domain/README.md:34-56`）。
- 再起動後にセッションへ結果を届ける手本は `schedule` パッケージ。`sessionController.resolveAgent` でセッションを復元し、`agent.followup()` で通知する（`schedule/schedule/src/runtime.ts:123`）。
- 構成：ジョブ ID・providerId・条件を storage-domain に保存し、`apply` 時に未完了ジョブのポーリングを再開する。完了したら followup で通知する。

## 7. OpenRouter API の最新仕様（方針書 §5, §6）

| 項目 | 内容 |
|---|---|
| 画像モデル一覧 | `GET /api/v1/images/models` → `{data: [{id, name, architecture, supported_parameters, endpoints}]}`。`supported_parameters` は enum / 範囲 / 真偽値。料金は一覧になく、`/images/models/{id}/endpoints` の `pricing[]`（`billable, unit, cost_usd, variant`）にある |
| 動画モデル一覧 | `GET /api/v1/videos/models` → `supported_resolutions / aspect_ratios / durations / frame_images`、`generate_audio`、`seed`、`pricing_skus`（文字列マップ、キーの種類は固定でない） |
| 一覧の認証 | 仕様上は Bearer 認証。実際はキーなしでも 200 が返る（明記はない） |
| 画像生成 | `POST /api/v1/images`、**同期**。応答は `{data: [{b64_json, media_type}], usage: {cost}}`。**Base64 のみ**。`n` は 1〜10、`input_references` は最大 16。残高が $1 以下だと 402 |
| 旧方式 | chat/completions の画像出力も使えるが、**新しい画像モデルは Image API にのみ追加**される。Image API を採用する |
| 動画生成 | `POST /api/v1/videos` が 202 を返す → `GET /videos/{id}` でポーリング（推奨例 30 秒）→ `GET /videos/{id}/content?index=0`（要 Authorization） |
| ジョブ状態 | `pending / in_progress / completed / failed / cancelled / expired`（終端は後ろの 4 つ）。方針書の 4 状態に `cancelled` と `expired` を追加する |
| 取消 API | **確認できず**。方針書どおり、ローカル監視の停止を「キャンセル」と表示しない |
| webhook | `callback_url`（HTTPS、HMAC 署名付き）。ローカル DSH では受けにくいので、MVP はポーリングにする |
| 未記載 | 成果物の保持期間、失敗ジョブの課金有無。完了後すぐにダウンロードして保存する |

出典：[画像モデル一覧](https://openrouter.ai/docs/api/api-reference/images/list-image-models)、[画像生成](https://openrouter.ai/docs/api/api-reference/images/generate-an-image)、[Image API 告知](https://openrouter.ai/blog/announcements/image-api/)、[動画モデル一覧](https://openrouter.ai/docs/api/api-reference/video-generation/list-all-video-generation-models)、[動画ジョブ登録](https://openrouter.ai/docs/api/api-reference/video-generation/create-videos)、[ジョブ状態](https://openrouter.ai/docs/api/api-reference/video-generation/get-videos)、[動画取得](https://openrouter.ai/docs/api/api-reference/video-generation/list-videos-content)、[動画生成ガイド](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)

## 8. 方針書 §11 チェックリストの回答

- [x] プロバイダー設定・資格情報参照の正式 API → **一部あり**。一覧と秘密値の解決は正式 API。baseURL・接続方式は settings 経由で読む（§2）。
- [x] ロケール / i18n API → **あり（クライアント側）**。日本語は同梱されていないので、言語パックを登録する（§4）。
- [x] 日英ローカライズの範囲とフォールバック → UI・通知・エラーは辞書で翻訳できる。モデル向けのツール説明は英語固定（§3, §4）。
- [x] OpenRouter の設定表現と生成 API パス → `llm-pi-ai` の `openrouter` プロファイル。生成 API は baseURL から組み立てる（§2, §7）。
- [~] モデル一覧の権限・アカウント別の利用可否 → 一覧 API はキーなしでも返るため、アカウント別の可否は判定できない。実行時の 401/402/403 で扱う。
- [x] ツール結果での画像・動画の表現 → 画像は attachment。動画は自前で保存して `present` で提示する（§5）。
- [x] ジョブ永続化・再起動時の回復 → storage-domain と schedule 方式（§6）。
- [x] 画像・動画 API の最新仕様 → §7。
- [ ] 対象 DSH バージョンと互換性方針 → 未決定。初期は `0.2.x` を peer の範囲にする想定。

## 9. 段階1に進む前に決めること

1. **日本語言語パックの扱い**：本プラグインが DSH に「日本語」を追加する方式（本体 UI は英語のまま）でよいか。
2. **実機確認**：§2 の「settings からプロファイルを読む」経路と、OpenRouter への実通信は、DSH を動かせる環境と OpenRouter の API キーで確認する必要がある。この作業環境からは openrouter.ai へ直接通信できなかった。
