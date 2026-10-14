/**
 * MediaLocale (Host side): the user-facing strings the Host itself shows,
 * currently the approval prompts. The Host has no locale service, so each
 * string is produced for every supported language at once and DSH picks the
 * viewer's language through its `{ en, ja }` localized-text convention,
 * falling back to English.
 * @module dsh-media-gen/src/messages
 */
/** Languages this plugin ships. `en` must stay complete; others fall back to it. */
export declare const LANGUAGES: readonly ["en", "ja"];
export type Language = typeof LANGUAGES[number];
/**
 * Translate one key, falling back to English and then to the key itself.
 * @param lang - target language.
 * @param key - dictionary key.
 * @param params - placeholder values.
 */
export declare function t(lang: Language, key: string, params?: Record<string, string>): string;
/**
 * Format a USD amount for a language without changing the value or unit.
 * @param lang - target language.
 * @param amount - USD value, or undefined when unknown.
 */
export declare function formatCost(lang: Language, amount: number | undefined): string;
/**
 * Format an approximate USD range, collapsing to one amount when both ends match.
 * @param lang - target language.
 * @param range - USD range, or undefined when unknown.
 */
export declare function formatCostRange(lang: Language, range: {
    min: number;
    max: number;
} | undefined): string;
/**
 * Build a localized text in DSH's `{ en, [locale] }` shape.
 * @param build - produces the string for one language.
 */
export declare function localized(build: (lang: Language) => string): {
    readonly en: string;
    readonly [locale: string]: string;
};
