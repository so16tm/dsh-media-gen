/**
 * MediaFiles: the images this plugin saved, so the browser can show them in
 * the chat. Only files listed here, or saved by a video job, are served by
 * the media file route; a path the plugin never wrote is refused.
 * @module dsh-media-gen/src/media-files
 */
import { openDomain } from "./storage.js";
/** Validator for stored entries. */
export const mediaFileSchema = {
    parse(raw) {
        const value = raw;
        if (typeof value !== 'object' || value === null || typeof value.mediaType !== 'string'
            || typeof value.bytes !== 'number' || typeof value.createdAt !== 'string') {
            throw new Error('media file must be { mediaType, bytes, createdAt }');
        }
        return value;
    },
};
/** Storage-domain declaration of the index. */
export const MEDIA_FILES_DOMAIN = {
    name: 'media_gen_files',
    version: 1,
    tables: { files: { valueSchema: mediaFileSchema } },
};
/** Process-local index used when DSH offers no storage domain. */
export class MemoryMediaFileIndex {
    rows = new Map();
    get(path) { return this.rows.get(path); }
    async add(path, file) {
        this.rows.set(path, { ...file, createdAt: new Date().toISOString() });
    }
}
/** Open the durable index. */
export async function openMediaFileIndex(service, attempts, delayMs) {
    const domain = await openDomain(service, MEDIA_FILES_DOMAIN, attempts, delayMs);
    const table = domain.table('files');
    return {
        get: path => table.get(path),
        add: (path, file) => table.put(path, { ...file, createdAt: new Date().toISOString() }),
        close: () => domain.close(),
    };
}
