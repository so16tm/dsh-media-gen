/**
 * InputImages: local images handed to a model as references or video
 * frames. Files are read from the session working directory, checked by
 * their signature, and sent as Base64 data URLs, because they have no public
 * URL the provider could fetch.
 * @module dsh-media-gen/src/input-images
 */
/** Largest input image accepted. */
export declare const MAX_INPUT_IMAGE_BYTES: number;
/** Most input images one call may carry. */
export declare const MAX_INPUT_IMAGES = 16;
/**
 * The `imageCompat` service of dsh-small-improvements, when installed. It
 * re-encodes WebP as PNG or JPEG for models that do not accept WebP.
 */
export interface ImageCompat {
    needsConversion(mediaType: string): boolean;
    toCompatible(data: Uint8Array, mediaType: string, options?: {
        maxBytes?: number;
    }): Promise<{
        data: Uint8Array;
        mediaType: string;
    }>;
}
/** One loaded input image. */
export interface InputImage {
    path: string;
    mediaType: string;
    bytes: number;
    dataUrl: string;
}
/**
 * Check a list of input paths before anything is read or billed.
 * @returns the trimmed, de-duplicated paths.
 */
export declare function inputPaths(paths: readonly string[] | undefined, name: string): string[];
/**
 * The input paths that lie outside the working directory. Such a file is sent
 * to the provider only after the user sees its path.
 * @param paths - absolute, or relative to `cwd`.
 * @param cwd - the session working directory.
 */
export declare function outsidePaths(paths: readonly string[], cwd: string): string[];
/**
 * Read one input image.
 * @param path - absolute, or relative to `cwd`.
 * @param cwd - the session working directory.
 * @param compat - when given, a WebP is sent as PNG or JPEG; a failed conversion sends it unchanged.
 * @throws MediaError INVALID_REQUEST when the file is missing, too large, or not an image.
 */
export declare function loadInputImage(path: string, cwd: string, maxBytes?: number, compat?: ImageCompat): Promise<InputImage>;
/** Read several input images in order. */
export declare function loadInputImages(paths: readonly string[], cwd: string, compat?: ImageCompat): Promise<InputImage[]>;
