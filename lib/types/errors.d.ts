/**
 * Stable error vocabulary. Codes never change with the display language; the
 * presentation layer maps each code to a localized message.
 * @module dsh-media-gen/src/errors
 */
/** Every failure class the plugin distinguishes. */
export type MediaErrorCode = 'NO_PROVIDER' | 'PROVIDER_NOT_FOUND' | 'MISSING_CREDENTIAL' | 'NO_MODEL' | 'UNSUPPORTED_MODEL' | 'UNSUPPORTED_PARAMETER' | 'INVALID_REQUEST' | 'LIMIT_EXCEEDED' | 'AUTH_FAILED' | 'INSUFFICIENT_BALANCE' | 'RATE_LIMITED' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'INVALID_RESPONSE';
/** A classified failure whose message is already free of secrets. */
export declare class MediaError extends Error {
    readonly code: MediaErrorCode;
    readonly name = "MediaError";
    /**
     * @param code - stable classification.
     * @param message - model-facing English explanation, already redacted.
     * @param options - optional HTTP status and cause.
     */
    constructor(code: MediaErrorCode, message: string, options?: {
        status?: number;
        cause?: unknown;
    });
    /** HTTP status of the provider response, when one caused the error. */
    readonly status?: number;
}
/**
 * Remove every secret occurrence from provider-supplied text before it can
 * reach a log, a tool result, or the model.
 * @param text - untrusted text.
 * @param secrets - values that must never appear.
 * @returns the redacted text.
 */
export declare function redact(text: string, secrets: readonly string[]): string;
/**
 * Classify a failed provider response.
 * @param status - HTTP status.
 * @param detail - provider message, already redacted.
 * @returns the classified error.
 */
export declare function classifyHttpError(status: number, detail: string): MediaError;
