/**
 * Browser-side labels. DSH picks the dictionary of the viewer's language and
 * falls back to English.
 * @module dsh-media-gen/src/client/locales
 */

/** Namespace of the model pickers and the settings page. */
export const PICKER_LOCALE = 'mediaGen'

/** Dictionaries keyed by DSH language code. */
export const PICKER_DICTIONARIES = {
  en: {
    image: 'Image',
    video: 'Video',
    imageModel: 'Default image model',
    videoModel: 'Default video model',
    sessionDefault: 'Default ({model})',
    noDefault: 'Not set',
    loading: 'Loading models…',
    loadFailed: 'Could not load models: {message}',
    refresh: 'Refresh list',
    maxImagesPerCall: 'Images per call (max)',
    maxVideoSeconds: 'Video length in seconds (max)',
    requireApproval: 'Ask before each generation, with the estimated cost',
    notifyOnVideoCompletion: 'Notify the session when a video job ends',
    summary: 'Image and video generation through the providers configured in DSH',
    saveFailed: 'The setting was not saved.',
    switchFailed: 'Could not switch the model: {message}',
    pickerTitle: 'Model used by media generation in this session',
  },
  ja: {
    image: '画像',
    video: '動画',
    imageModel: '既定の画像モデル',
    videoModel: '既定の動画モデル',
    sessionDefault: '既定（{model}）',
    noDefault: '未設定',
    loading: 'モデルを読み込んでいます…',
    loadFailed: 'モデルを読み込めませんでした：{message}',
    refresh: '一覧を更新',
    maxImagesPerCall: '1 回あたりの最大枚数',
    maxVideoSeconds: '動画の最大秒数',
    requireApproval: '生成のたびに、概算料金つきで確認する',
    notifyOnVideoCompletion: '動画ジョブが終わったらセッションに知らせる',
    summary: 'DSH に設定したプロバイダーで画像と動画を生成します',
    saveFailed: '設定を保存できませんでした。',
    switchFailed: 'モデルを切り替えられませんでした：{message}',
    pickerTitle: 'このセッションの画像・動画生成で使うモデル',
  },
} satisfies Record<string, Record<string, string>>

/** Label keys. */
export type PickerKey = keyof typeof PICKER_DICTIONARIES.en

/** Translator handed to slot components by DSH. */
export type Translate = (key: PickerKey, params?: Record<string, string>) => string
