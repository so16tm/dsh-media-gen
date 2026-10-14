/**
 * MediaOutput: persist generated images as files under the session working
 * directory and, when an attachment store is mounted, as durable attachments
 * the chat can display. Files are the lasting copy; provider URLs are never
 * relied on.
 * @module dsh-media-gen/src/output
 */
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment';
/**
 * Identify a supported image from its signature; the provider's declared type
 * is not trusted.
 */
export declare function sniffImage(data: Uint8Array): ImageMediaType | undefined;
/** One stored image. */
export interface SavedImage {
    /** Absolute file path. */
    path: string;
    mediaType: ImageMediaType;
    bytes: number;
    /** Durable attachment, absent when no store is mounted or it refused the image. */
    attachment?: ImageAttachmentRef;
}
/**
 * Resolve the output directory inside the working directory. An absolute or
 * escaping configuration is refused so generated files stay where the user
 * expects them.
 */
export declare function resolveOutputDir(cwd: string, configured: string): string;
/**
 * Write a new file named `<base>.<extension>`, or `<base>-2.<extension>` and
 * so on when that name is taken, e.g. by a generation in the same second.
 * Existing files are never overwritten.
 * @returns the path written.
 */
export declare function writeNewFile(dir: string, base: string, extension: string, data: Uint8Array): Promise<string>;
/** File-name-safe slug of a model id. */
export declare function slug(value: string): string;
/** Local `YYYYMMDD-HHMMSS` stamp used in output file names. */
export declare function timestamp(date: Date): string;
/**
 * Save generated images.
 * @param images - decoded image bytes in provider order.
 * @param options - destination directory, naming, and optional attachment store.
 * @returns saved images and how many attachments were refused.
 */
export declare function saveImages(images: readonly Uint8Array[], options: {
    dir: string;
    model: string;
    attachments?: AttachmentStore | undefined;
    now?: Date;
    maxBytes: number;
}): Promise<{
    saved: SavedImage[];
    attachmentFailures: number;
}>;
