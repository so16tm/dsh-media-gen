/**
 * MediaFiles: the images this plugin saved, so the browser can show them in
 * the chat. Only files listed here, or saved by a video job, are served by
 * the media file route; a path the plugin never wrote is refused.
 * @module dsh-media-gen/src/media-files
 */
import { type StorageDomainService } from './storage.ts';
/** One saved file. */
export interface MediaFile {
    mediaType: string;
    bytes: number;
    createdAt: string;
}
/** Validator for stored entries. */
export declare const mediaFileSchema: {
    parse(raw: unknown): MediaFile;
};
/** Storage-domain declaration of the index. */
export declare const MEDIA_FILES_DOMAIN: {
    readonly name: "media_gen_files";
    readonly version: 1;
    readonly tables: {
        readonly files: {
            readonly valueSchema: {
                parse(raw: unknown): MediaFile;
            };
        };
    };
};
/** Index of saved files keyed by absolute path. */
export interface MediaFileIndex {
    get(path: string): MediaFile | undefined;
    add(path: string, file: Omit<MediaFile, 'createdAt'>): Promise<void>;
    close?(): Promise<void>;
}
/** Process-local index used when DSH offers no storage domain. */
export declare class MemoryMediaFileIndex implements MediaFileIndex {
    private readonly rows;
    get(path: string): MediaFile | undefined;
    add(path: string, file: Omit<MediaFile, 'createdAt'>): Promise<void>;
}
/** Open the durable index. */
export declare function openMediaFileIndex(service: StorageDomainService, attempts?: number, delayMs?: number): Promise<MediaFileIndex>;
