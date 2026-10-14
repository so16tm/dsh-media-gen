/**
 * Stable error vocabulary. Codes never change with the display language; the
 * presentation layer maps each code to a localized message.
 * @module dsh-media-gen/src/errors
 */
/** A classified failure whose message is already free of secrets. */
export class MediaError extends Error {
    code;
    name = 'MediaError';
    /**
     * @param code - stable classification.
     * @param message - model-facing English explanation, already redacted.
     * @param options - optional HTTP status and cause.
     */
    constructor(code, message, options) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.code = code;
        if (options?.status !== undefined)
            this.status = options.status;
    }
    /** HTTP status of the provider response, when one caused the error. */
    status;
}
/**
 * Remove every secret occurrence from provider-supplied text before it can
 * reach a log, a tool result, or the model.
 * @param text - untrusted text.
 * @param secrets - values that must never appear.
 * @returns the redacted text.
 */
export function redact(text, secrets) {
    let out = text;
    for (const secret of secrets) {
        if (secret.length >= 4)
            out = out.split(secret).join('[redacted]');
    }
    // Bearer-shaped tokens in echoed headers are removed even when unknown.
    return out.replace(/sk-or-[A-Za-z0-9_-]{8,}/gu, '[redacted]');
}
/**
 * Classify a failed provider response.
 * @param status - HTTP status.
 * @param detail - provider message, already redacted.
 * @returns the classified error.
 */
export function classifyHttpError(status, detail) {
    const suffix = detail.length > 0 ? `: ${detail}` : '';
    if (status === 401 || status === 403)
        return new MediaError('AUTH_FAILED', `the provider rejected the credential (HTTP ${status})${suffix}`, { status });
    if (status === 402)
        return new MediaError('INSUFFICIENT_BALANCE', `the provider account has insufficient credit (HTTP 402)${suffix}`, { status });
    if (status === 429)
        return new MediaError('RATE_LIMITED', `the provider rate limit was reached (HTTP 429)${suffix}`, { status });
    if (status === 404)
        return new MediaError('UNSUPPORTED_MODEL', `the provider does not serve this model or endpoint (HTTP 404)${suffix}`, { status });
    if (status === 400 || status === 422)
        return new MediaError('INVALID_REQUEST', `the provider rejected the request (HTTP ${status})${suffix}`, { status });
    if (status === 408 || status === 504)
        return new MediaError('TIMEOUT', `the provider timed out (HTTP ${status})${suffix}`, { status });
    return new MediaError('PROVIDER_ERROR', `the provider failed (HTTP ${status})${suffix}`, { status });
}
