/**
 * MediaLocale (Host side): the user-facing strings the Host itself shows,
 * currently the approval prompts. The Host has no locale service, so each
 * string is produced for every supported language at once and DSH picks the
 * viewer's language through its `{ en, ja }` localized-text convention,
 * falling back to English.
 * @module dsh-media-gen/src/messages
 */
/** Languages this plugin ships. `en` must stay complete; others fall back to it. */
export const LANGUAGES = ['en', 'ja'];
/** Intl locale used for number formatting in each language. */
const FORMAT_LOCALE = { en: 'en-US', ja: 'ja-JP' };
const DICTIONARY = {
    en: {
        'approval.image': p => `Generate ${p.count} image(s) with ${p.model} (${p.provider}). Estimated cost: ${p.cost}.`,
        'approval.video': p => `Generate a ${p.seconds}-second video with ${p.model} (${p.provider}). Estimated cost: ${p.cost}.`,
        'approval.video.default': p => `Generate a video of the model's default length with ${p.model} (${p.provider}). Estimated cost: ${p.cost}.`,
        'approval.unpriced.image': p => `Generate images. The cost could not be estimated (${p.detail}).`,
        'approval.unpriced.video': p => `Generate a video. The cost could not be estimated (${p.detail}).`,
        'approval.notes': p => `Save prompt notes for ${p.model}. Every later conversation's agent reads them.\n${p.notes || '(delete the notes)'}`,
        'approval.outside': p => `These input images are outside the working directory and will be sent to the provider: ${p.paths}`,
        'approval.prompt': p => `Prompt: ${p.prompt}`,
        'approval.variation': p => `Prompt ${p.n}: ${p.prompt}`,
        'approval.inputs': p => `Input images: ${p.inputs}`,
        'approval.repeat': () => 'This is another generation in the same request. Allow it if you asked for several; otherwise reject it.',
        'approval.subagent': () => 'A subagent the agent delegated to is asking to generate.',
        'approval.session': () => 'To stop asking in this conversation, use "Allow in this conversation" in the chat input\'s Media menu, or /media-approval on.',
        'cost.unknown': () => 'unknown',
        'cost.usd': p => `about ${p.amount} USD`,
        'cost.range': p => `about ${p.min} to ${p.max} USD`,
    },
    ja: {
        'approval.image': p => `${p.model}（${p.provider}）で画像を ${p.count} 枚生成します。概算料金：${p.cost}`,
        'approval.video': p => `${p.model}（${p.provider}）で ${p.seconds} 秒の動画を生成します。概算料金：${p.cost}`,
        'approval.video.default': p => `${p.model}（${p.provider}）でモデル既定の長さの動画を生成します。概算料金：${p.cost}`,
        'approval.unpriced.image': p => `画像を生成します。料金を概算できませんでした（${p.detail}）。`,
        'approval.unpriced.video': p => `動画を生成します。料金を概算できませんでした（${p.detail}）。`,
        'approval.notes': p => `${p.model} の書き方メモを保存します。以後のすべての会話のエージェントが読みます。\n${p.notes || '（メモを削除）'}`,
        'approval.outside': p => `次の入力画像は作業フォルダーの外にあり、プロバイダーに送られます：${p.paths}`,
        'approval.prompt': p => `プロンプト：${p.prompt}`,
        'approval.variation': p => `プロンプト ${p.n}：${p.prompt}`,
        'approval.inputs': p => `入力画像：${p.inputs}`,
        'approval.repeat': () => 'これは同じ依頼の中での追加の生成です。複数を頼んだ場合は許可し、そうでなければ拒否してください。',
        'approval.subagent': () => 'エージェントが作業を任せたサブエージェントからの生成です。',
        'approval.session': () => 'この会話で以後確認しない場合は、チャット欄の「画像・動画」メニューの「この会話では許可」か、/media-approval on を使ってください。',
        'cost.unknown': () => '不明',
        'cost.usd': p => `約 ${p.amount} USD`,
        'cost.range': p => `約 ${p.min}〜${p.max} USD`,
    },
};
/**
 * Translate one key, falling back to English and then to the key itself.
 * @param lang - target language.
 * @param key - dictionary key.
 * @param params - placeholder values.
 */
export function t(lang, key, params = {}) {
    const template = DICTIONARY[lang][key] ?? DICTIONARY.en[key];
    return template === undefined ? key : template(params);
}
/**
 * Format a USD amount for a language without changing the value or unit.
 * @param lang - target language.
 * @param amount - USD value, or undefined when unknown.
 */
export function formatCost(lang, amount) {
    if (amount === undefined)
        return t(lang, 'cost.unknown');
    const formatted = new Intl.NumberFormat(FORMAT_LOCALE[lang], { maximumFractionDigits: 4 }).format(amount);
    return t(lang, 'cost.usd', { amount: formatted });
}
/**
 * Format an approximate USD range, collapsing to one amount when both ends match.
 * @param lang - target language.
 * @param range - USD range, or undefined when unknown.
 */
export function formatCostRange(lang, range) {
    if (range === undefined || range.min === range.max)
        return formatCost(lang, range?.min);
    const format = (n) => new Intl.NumberFormat(FORMAT_LOCALE[lang], { maximumFractionDigits: 4 }).format(n);
    return t(lang, 'cost.range', { min: format(range.min), max: format(range.max) });
}
/**
 * Build a localized text in DSH's `{ en, [locale] }` shape.
 * @param build - produces the string for one language.
 */
export function localized(build) {
    const out = { en: build('en') };
    for (const lang of LANGUAGES)
        out[lang] = build(lang);
    return out;
}
