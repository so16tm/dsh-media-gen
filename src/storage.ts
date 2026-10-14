/**
 * Storage: the part of DSH's storage-domain service this plugin uses. Domain
 * specs are declared structurally so the plugin needs no runtime dependency
 * on the storage packages; DSH validates every record with the spec's
 * `parse` when a domain opens.
 * @module dsh-media-gen/src/storage
 */

/** Record validator in the shape the storage domain expects of a zod schema. */
export interface RecordSchema<V> {
  parse(raw: unknown): V
}

/** Structural domain declaration, compatible with DSH's `defineDomain` output. */
export interface DomainSpecLike {
  readonly name: string
  readonly version: number
  readonly tables: Readonly<Record<string, { readonly valueSchema: RecordSchema<unknown> }>>
}

/** One open table. */
export interface DomainTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** One open domain. */
export interface OpenDomain {
  table(name: string): DomainTable<unknown>
  close(): Promise<void>
}

/** DSH's `ctx.storageDomain`. */
export interface StorageDomainService {
  open(spec: DomainSpecLike): Promise<OpenDomain>
}

/**
 * Open a domain, retrying while a previous instance of this plugin is still
 * closing it after a reload.
 */
export async function openDomain(service: StorageDomainService, spec: DomainSpecLike, attempts = 10, delayMs = 200): Promise<OpenDomain> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await service.open(spec)
    } catch (error) {
      const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
      if (code !== 'already-open' || attempt >= attempts) throw error
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
}
