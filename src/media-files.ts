/**
 * MediaFiles: the images this plugin saved, so the browser can show them in
 * the chat. Only files listed here, or saved by a video job, are served by
 * the media file route; a path the plugin never wrote is refused.
 * @module dsh-media-gen/src/media-files
 */

import { openDomain, type DomainSpecLike, type DomainTable, type StorageDomainService } from './storage.ts'

/** One saved file. */
export interface MediaFile {
  mediaType: string
  bytes: number
  createdAt: string
}

/** Validator for stored entries. */
export const mediaFileSchema = {
  parse(raw: unknown): MediaFile {
    const value = raw as Partial<MediaFile> | null
    if (typeof value !== 'object' || value === null || typeof value.mediaType !== 'string'
      || typeof value.bytes !== 'number' || typeof value.createdAt !== 'string') {
      throw new Error('media file must be { mediaType, bytes, createdAt }')
    }
    return value as MediaFile
  },
}

/** Storage-domain declaration of the index. */
export const MEDIA_FILES_DOMAIN = {
  name: 'media_gen_files',
  version: 1,
  tables: { files: { valueSchema: mediaFileSchema } },
} as const satisfies DomainSpecLike

/** Index of saved files keyed by absolute path. */
export interface MediaFileIndex {
  get(path: string): MediaFile | undefined
  add(path: string, file: Omit<MediaFile, 'createdAt'>): Promise<void>
  close?(): Promise<void>
}

/** Process-local index used when DSH offers no storage domain. */
export class MemoryMediaFileIndex implements MediaFileIndex {
  private readonly rows = new Map<string, MediaFile>()
  get(path: string): MediaFile | undefined { return this.rows.get(path) }
  async add(path: string, file: Omit<MediaFile, 'createdAt'>): Promise<void> {
    this.rows.set(path, { ...file, createdAt: new Date().toISOString() })
  }
}

/** Open the durable index. */
export async function openMediaFileIndex(service: StorageDomainService, attempts?: number, delayMs?: number): Promise<MediaFileIndex> {
  const domain = await openDomain(service, MEDIA_FILES_DOMAIN, attempts, delayMs)
  const table = domain.table('files') as DomainTable<MediaFile>
  return {
    get: path => table.get(path),
    add: (path, file) => table.put(path, { ...file, createdAt: new Date().toISOString() }),
    close: () => domain.close(),
  }
}
