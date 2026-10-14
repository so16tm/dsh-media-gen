import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

interface Loaded { id: string; exports: { inject: string[]; apply(ctx: unknown): void } }

let loaded: Loaded

beforeAll(() => {
  execFileSync(process.execPath, ['scripts/build-client.mjs'], { stdio: 'inherit' })
  const code = readFileSync('lib/client.js', 'utf8')
  const required: string[] = []
  const window = {
    __ModuleLoader__: {
      load({ id, factory }: { id: string; factory: (require: (name: string) => unknown) => Loaded['exports'] }) {
        loaded = { id, exports: factory((name) => { required.push(name); return {} }) }
      },
    },
  }
  new Function('window', code)(window)
  expect(required.every(name => ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'].includes(name))).toBe(true)
}, 30_000)

describe('client bundle', () => {
  it('registers under the package name and adds a video preview, a settings page, and a model picker', async () => {
    expect(loaded.id).toBe('dsh-media-gen')
    expect(loaded.exports.inject).toEqual(['documentPreviews', 'slots', 'locale', 'sessions'])
    const lines: string[] = []
    const previews: { id: string; extensions: string[]; loading: string; title(): string }[] = []
    const bodies: { name: string; key?: string; id?: string; inject?: (sessionId: string) => { command(line: string): Promise<void> } }[] = []
    const dictionaries: Record<string, Record<string, Record<string, string>>> = {}
    loaded.exports.apply({
      effect: (fn: () => unknown) => { fn() },
      locale: {
        register: (ns: string, d: Record<string, Record<string, string>>) => { dictionaries[ns] = d; return () => {} },
        bind: (ns: string) => (key: string) => dictionaries[ns]?.ja?.[key] ?? key,
      },
      documentPreviews: { register: (def: (typeof previews)[number]) => { previews.push(def); return () => {} } },
      slots: {
        inject: (_name: string, fn: () => () => void) => fn(),
        register: (options: (typeof bodies)[number]) => { bodies.push(options); return () => {} },
      },
      sessions: {
        binding: (sessionId: string) => sessionId !== 's1' ? undefined : {
          session: { command: async (line: string) => { lines.push(line); return { ok: true, value: { matched: true } } } },
        },
      },
    })
    expect(previews).toHaveLength(1)
    expect(previews[0]).toMatchObject({ id: 'dsh-media-gen/video', extensions: ['mp4', 'm4v', 'webm', 'mov'], loading: 'bytes-complete' })
    expect(previews[0]?.title()).toBe('動画')
    expect(bodies.map(({ name, key, id }) => ({ name, key, id }))).toEqual([
      { name: 'sidebar.right.tab.document', key: 'dsh-media-gen/video', id: undefined },
      { name: 'plugins.row.config', key: 'dsh-media-gen#media-gen', id: undefined },
      { name: 'tool.call.toolview', key: 'media_generate_image', id: undefined },
      { name: 'tool.call.toolview', key: 'media_generate_video', id: undefined },
      { name: 'conversation.chat.commandview', key: 'image', id: undefined },
      { name: 'conversation.chat.commandview', key: 'video', id: undefined },
      { name: 'conversation.input.left', key: undefined, id: 'dsh-media-gen.models' },
    ])
    expect(Object.keys(dictionaries).sort()).toEqual(['mediaGen', 'mediaGenVideo'])
    expect(Object.keys(dictionaries.mediaGen?.ja ?? {}).sort()).toEqual(Object.keys(dictionaries.mediaGen?.en ?? {}).sort())
    const picker = bodies.find(b => b.id === 'dsh-media-gen.models')!.inject!
    await picker('s1').command('/media-model image g/img')
    expect(lines).toEqual(['/media-model image g/img'])
    await expect(picker('s2').command('/media-model image g/img')).rejects.toThrow('not open')
  })
})
