/**
 * InputImages: local images handed to a model as references or video
 * frames. Files are read from the session working directory, checked by
 * their signature, and sent as Base64 data URLs, because they have no public
 * URL the provider could fetch.
 * @module dsh-media-gen/src/input-images
 */
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment';
/** Largest input image accepted. */
export declare const MAX_INPUT_IMAGE_BYTES: number;
/**
 * Formats video models take as frames and references. OpenRouter's video
 * models (Veo among them) refuse WebP with "Expected JPEG or PNG".
 */
export declare const VIDEO_INPUT_TYPES: readonly ImageMediaType[];
/** Most input images one call may carry. */
export declare const MAX_INPUT_IMAGES = 16;
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
 * @param accept - formats the model takes; another format is re-encoded as
 * PNG. Undefined sends the file as it is.
 * @throws MediaError INVALID_REQUEST when the file is missing, too large, or not an image.
 */
export declare function loadInputImage(path: string, cwd: string, maxBytes?: number, accept?: readonly ImageMediaType[]): Promise<InputImage>;
/** Read several input images in order. */
export declare function loadInputImages(paths: readonly string[], cwd: string, accept?: readonly ImageMediaType[]): Promise<InputImage[]>;
