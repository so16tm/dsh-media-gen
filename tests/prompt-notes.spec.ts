import { describe, expect, it } from 'vitest'
import { openPromptNoteStore, promptNoteSchema, type PromptNote } from '../src/prompt-notes.ts'
import type { StorageDomainService } from '../src/storage.ts'

describe('prompt note storage', () => {
  it('validates records and keeps them in the storage domain', async () => {
    expect(() => promptNoteSchema.parse({ notes: 1, updatedAt: 'x' })).toThrow()
    const rows = new Map<string, PromptNote>()
    const service: StorageDomainService = {
      async open(spec) {
        expect(spec.name).toBe('media_gen_notes')
        return {
          table: () => ({
            get: (k: string) => rows.get(k),
            entries: () => rows.entries(),
            put: async (k: string, v: unknown) => { rows.set(k, promptNoteSchema.parse(v)) },
            delete: async (k: string) => rows.delete(k),
          }),
          close: async () => {},
        }
      },
    }
    const store = await openPromptNoteStore(service)
    expect(store.durable).toBe(true)
    await store.set('g/img', '  tags, English  ')
    expect(store.get('g/img')?.notes).toBe('tags, English')
    expect(store.list().map(([model]) => model)).toEqual(['g/img'])
    await store.set('g/img', '')
    expect(rows.size).toBe(0)
    await expect(store.set(' ', 'x')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})
