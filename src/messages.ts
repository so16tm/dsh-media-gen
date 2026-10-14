/**
 * MediaLocale (Host side): the user-facing strings the Host itself shows,
 * currently the approval prompt. The Host has no locale service, so each
 * string is produced for every supported language at once and DSH picks the
 * viewer's language through its `{ en, ja }` localized-text convention,
 * falling back to English.
 * @module dsh-media-gen/src/messages
 */

/** Languages this plugin ships. `en` must stay complete; others fall back to it. */
export const LANGUAGES = ['en', 'ja'] as const
export type Language = typeof LANGUAGES[number]

/** Intl locale used for number formatting in each language. */
const FORMAT_LOCALE: Record<Language, string> = { en: 'en-US', ja: 'ja-JP' }

type Template = (p: Record<string, string>) => string

const DICTIONARY: Record<Language, Record<string, Template>> = {
  en: {
    'approval.image': p => `Generate ${p.count} image(s) with ${p.model} (${p.provider}). Estimated cost: ${p.cost}.`,
    'approval.image.prompt': p => `Prompt: ${p.prompt}`,
    'cost.unknown': () => 'unknown',
    'cost.usd': p => `about ${p.amount} USD`,
  },
  ja: {
    'approval.image': p => `${p.model}（${p.provider}）で画像を ${p.count} 枚生成します。概算料金：${p.cost}`,
    'approval.image.prompt': p => `プロンプト：${p.prompt}`,
    'cost.unknown': () => '不明',
    'cost.usd': p => `約 ${p.amount} USD`,
  },
}

/**
 * Translate one key, falling back to English and then to the key itself.
 * @param lang - target language.
 * @param key - dictionary key.
 * @param params - placeholder values.
 */
export function t(lang: Language, key: string, params: Record<string, string> = {}): string {
  const template = DICTIONARY[lang][key] ?? DICTIONARY.en[key]
  return template === undefined ? key : template(params)
}

/**
 * Format a USD amount for a language without changing the value or unit.
 * @param lang - target language.
 * @param amount - USD value, or undefined when unknown.
 */
export function formatCost(lang: Language, amount: number | undefined): string {
  if (amount === undefined) return t(lang, 'cost.unknown')
  const formatted = new Intl.NumberFormat(FORMAT_LOCALE[lang], { maximumFractionDigits: 4 }).format(amount)
  return t(lang, 'cost.usd', { amount: formatted })
}

/**
 * Build a localized text in DSH's `{ en, [locale] }` shape.
 * @param build - produces the string for one language.
 */
export function localized(build: (lang: Language) => string): { readonly en: string; readonly [locale: string]: string } {
  const out: Record<string, string> = { en: build('en') }
  for (const lang of LANGUAGES) out[lang] = build(lang)
  return out as { readonly en: string; readonly [locale: string]: string }
}
