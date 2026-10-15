import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'
import type { DomainSpecLike, StorageDomainService } from '../src/storage.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

interface FakeAgent {
  status: string
  session: { id: string }
  followed: unknown[]
  injected: unknown[]
  followup(message: unknown): void
  inject(message: unknown): void
}

function fakeAgent(id: string, status = 'idle'): FakeAgent {
  const agent: FakeAgent = {
    status, session: { id }, followed: [], injected: [],
    followup: (m) => { agent.followed.push(m) },
    inject: (m) => { agent.injected.push(m) },
  }
  return agent
}

/** In-memory stand-in for DSH's storage-domain service. */
function memoryStorage(): StorageDomainService {
  const domains = new Map<string, Map<string, Map<string, unknown>>>()
  return {
    async open(spec: DomainSpecLike) {
      const tables = domains.get(spec.name) ?? new Map<string, Map<string, unknown>>()
      domains.set(spec.name, tables)
      return {
        table: (name: string) => {
          const rows = tables.get(name) ?? new Map<string, unknown>()
          tables.set(name, rows)
          const schema = spec.tables[name]!.valueSchema
          return {
            get: (k: string) => rows.get(k),
            entries: () => rows.entries(),
            put: async (k: string, v: unknown) => { rows.set(k, schema.parse(v)) },
            delete: async (k: string) => rows.delete(k),
          }
        },
        close: async () => {},
      }
    },
  }
}

/**
 * Fake plugin context. `storage` says whether DSH's storage service is there
 * when the plugin starts, arrives after it (call `provideStorage`), or is absent.
 */
function fakeContext(agents: FakeAgent[] = [], storage: 'present' | 'late' | 'none' = 'present') {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const tools: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }[] = []
  const disposers: (() => unknown)[] = []
  const guards: ((exec: unknown) => string | undefined)[] = []
  const commands: { name: string; handler?(invocation: unknown): Promise<{ kind: string; text: string }> }[] = []
  const services: Record<string, unknown> = {
    credentials: { resolve: async () => ({ value: 'sk-or-k' }) },
    agents: { get: (id: string) => agents.find(a => a.session.id === id) },
    commands: { register: (command: { name: string }) => { commands.push(command) } },
    ...storage === 'present' ? { storageDomain: memoryStorage() } : {},
  }
  const waiting: { deps: string[]; fn: (c: Record<string, unknown>) => void }[] = []
  const run = (deps: string[], fn: (c: Record<string, unknown>) => void) => fn(Object.fromEntries(deps.map(d => [d, services[d]])))
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'openrouter', name: 'OpenRouter' }],
      listConfigurableProviders: () => [],
    },
    tools: {
      register: (tool: (typeof tools)[number]) => { tools.push(tool) },
      guard: (guard: (exec: unknown) => string | undefined) => { guards.push(guard); return () => {} },
    },
    on: (name: string, fn: (...args: never[]) => unknown) => { listeners.set(name, fn) },
    get: (name: string) => services[name],
    effect: (fn: () => () => unknown) => { disposers.push(fn()) },
    inject: (deps: string[], fn: (c: Record<string, unknown>) => void) => {
      if (deps.every(d => services[d] !== undefined)) run(deps, fn)
      else waiting.push({ deps, fn })
    },
    logger: { warn: () => {} },
  }
  const provideStorage = () => {
    services.storageDomain = memoryStorage()
    for (const w of waiting.splice(0)) if (w.deps.every(d => services[d] !== undefined)) run(w.deps, w.fn)
  }
  return { ctx, listeners, tools, guards, commands, provideStorage, dispose: async () => { for (const d of disposers) await d() } }
}

function stubNetwork() {
  vi.stubGlobal('fetch', (async (url: string) => {
    if (url.endsWith('/images/models')) return Response.json({ data: [{ id: 'g/img', name: 'G Image', supported_parameters: {} }] })
    if (url.endsWith('/endpoints')) return Response.json({ data: { endpoints: [{ pricing: [{ billable: 'output_image', unit: 'image', cost_usd: 0.04 }] }] } })
    if (url.endsWith('/videos/models')) {
      return Response.json({ data: [{ id: 'v/vid', name: 'V Video', supported_durations: [4, 8], pricing_skus: { video_second: '0.1' } }] })
    }
    if (url.endsWith('/videos')) return Response.json({ id: 'job-9', status: 'pending' }, { status: 202 })
    if (url.endsWith('/videos/job-9')) return Response.json({ id: 'job-9', status: 'failed', error: 'policy' })
    return Response.json({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
  }) as unknown as typeof fetch)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('plugin apply', () => {
  it('registers the image and video tools', async () => {
    const { ctx, tools, dispose } = fakeContext()
    apply(ctx as never, Config({}) as never)
    expect(tools.map(t => t.name)).toEqual([
      'media_list_models', 'media_generate_image', 'media_generate_video', 'media_video_status',
      'media_get_prompt_notes', 'media_set_prompt_notes',
    ])
    await dispose()
  })

  it('generates directly with /image and /video, asking for --yes while approval is on', async () => {
    stubNetwork()
    const cwd = await mkdtemp(join(tmpdir(), 'media-'))
    const agent = Object.assign(fakeAgent('s1'), { session: { id: 's1', header: { cwd } } })
    const { ctx, commands, dispose } = fakeContext([agent])
    apply(ctx as never, Config({}) as never)
    const run = (name: string, rawInput: string) =>
      commands.find(c => c.name === name)!.handler!({ agent, rawInput, signal: new AbortController().signal })
    expect(commands.map(c => c.name)).toEqual(['media-model', 'media-approval', 'image', 'video', 'media-jobs'])
    const preview = await run('image', '--model g/img a red fox')
    expect(preview).toMatchObject({ kind: 'success' })
    expect(preview.text).toContain('about 0.04 USD')
    expect(preview.text).toContain('--yes')
    const saved = await run('image', '--model g/img --yes a red fox')
    expect(saved.text).toMatch(/^Saved 1 image\(s\) from g\/img/u)
    expect(saved.text.split('\n')[1]).toMatch(/^- .*generated-media.*\.png$/u)
    const video = await run('video', '--model v/vid --duration 4 --yes waves')
    expect(video).toMatchObject({ kind: 'success' })
    expect(video.text).toContain('job-9')
    expect((await run('media-jobs', '')).text).toContain('job-9')
    // The provider reports the job failed: the session hears of it without an agent turn.
    expect((await run('media-jobs', 'job-9')).text).toContain('policy')
    expect(agent.followed).toHaveLength(0)
    expect(agent.injected).toHaveLength(1)
    expect(await run('video', '--duration 4 x')).toMatchObject({ kind: 'error' })
    await dispose()
  })

  it('saves prompt notes and shows them with the model listing', async () => {
    stubNetwork()
    const { ctx, tools, dispose } = fakeContext()
    apply(ctx as never, Config({}) as never)
    const tool = (name: string) => tools.find(t => t.name === name)!
    const exec = { signal: new AbortController().signal }
    expect(await tool('media_set_prompt_notes').execute({ model: ' v/vid ', notes: 'English only; one sentence per shot.' }, exec))
      .toMatchObject({ model: 'v/vid', notes: 'English only; one sentence per shot.', durable: true })
    const listing = await tool('media_list_models').execute({ kind: 'video' }, exec) as { providers: { videoModels: { id: string; promptNotes?: string }[] }[] }
    expect(listing.providers[0]?.videoModels[0]).toMatchObject({ id: 'v/vid', promptNotes: 'English only; one sentence per shot.' })
    expect(await tool('media_get_prompt_notes').execute({}, exec)).toMatchObject({ notes: [{ model: 'v/vid' }] })
    await expect(tool('media_set_prompt_notes').execute({ model: 'v/vid', notes: 'x'.repeat(2001) }, exec)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await tool('media_set_prompt_notes').execute({ model: 'v/vid', notes: ' ' }, exec)).toMatchObject({ deleted: true })
    expect(await tool('media_get_prompt_notes').execute({ model: 'v/vid' }, exec)).toMatchObject({ notes: [] })
    await dispose()
  })

  it('waits for a storage service that starts after the plugin', async () => {
    stubNetwork()
    const { ctx, tools, provideStorage, dispose } = fakeContext([], 'late')
    apply(ctx as never, Config({}) as never)
    const saved = tools.find(t => t.name === 'media_set_prompt_notes')!.execute({ model: 'v/vid', notes: 'English only.' }, { signal: new AbortController().signal })
    provideStorage()
    expect(await saved).toMatchObject({ durable: true })
    await dispose()
  })

  it('uses the model chosen with /media-model for the calling session only', async () => {
    stubNetwork()
    const cwd = await mkdtemp(join(tmpdir(), 'media-'))
    const { ctx, tools, commands, dispose } = fakeContext([fakeAgent('s1')])
    apply(ctx as never, Config({}) as never)
    const command = commands.find(c => c.name === 'media-model')!
    const signal = new AbortController().signal
    const caller = fakeAgent('s1')
    expect(await command.handler!({ agent: caller, rawInput: ' video v/vid', signal })).toMatchObject({ kind: 'success' })
    // The agent hears of the change, so it writes the prompt for the new model.
    expect(JSON.stringify(caller.injected)).toContain('Leave model unset in media_generate_video')
    await command.handler!({ agent: caller, rawInput: 'video', signal })
    expect(caller.injected).toHaveLength(1)
    const generate = tools.find(t => t.name === 'media_generate_video')!
    const submitted = await generate.execute({ prompt: 'a wave', duration: 4 }, { signal, agent: { session: { id: 's1', header: { cwd } } } }) as { model: string }
    expect(submitted.model).toBe('v/vid')
    // A model the agent repeats from earlier in the conversation does not override the session's choice.
    const stale = await generate.execute({ prompt: 'a wave', duration: 4, model: 'old/vid' }, { signal, agent: { session: { id: 's1', header: { cwd } } } }) as { model: string }
    expect(stale.model).toBe('v/vid')
    // The listing tells the agent which model the user selected for this session.
    const list = tools.find(t => t.name === 'media_list_models')!
    expect(await list.execute({ kind: 'video' }, { signal, agent: { session: { id: 's1' } } })).toMatchObject({ selected: { model: 'v/vid', by: 'session' } })
    expect(await list.execute({ kind: 'video' }, { signal, agent: { session: { id: 's2' } } })).toMatchObject({ selected: null })
    await expect(generate.execute({ prompt: 'a wave', duration: 4 }, { signal, agent: { session: { id: 's2', header: { cwd } } } })).rejects.toMatchObject({ code: 'NO_MODEL' })
    await dispose()
  })

  it('asks for video approval with a duration-based estimate in both languages', async () => {
    stubNetwork()
    const { ctx, listeners, dispose } = fakeContext()
    apply(ctx as never, Config({ defaultVideoModel: 'v/vid' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const signal = new AbortController().signal
    const exact = await hook({ name: 'media_generate_video', arguments: { prompt: 'a wave', duration: 8 }, signal }, async () => ({ kind: 'allow' })) as { displayReason: Record<string, string> }
    expect(exact.displayReason.en).toContain('Generate a 8-second video with V Video (openrouter). Estimated cost: about 0.8 USD.')
    expect(exact.displayReason.ja).toContain('V Video（openrouter）で 8 秒の動画を生成します。概算料金：約 0.8 USD')
    const open = await hook({ name: 'media_generate_video', arguments: { prompt: 'a wave' }, signal }, async () => ({ kind: 'allow' })) as { displayReason: Record<string, string> }
    expect(open.displayReason.ja).toContain('モデル既定の長さ')
    expect(open.displayReason.ja).toContain('約 0.4〜0.8 USD')
    await dispose()
  })

  it('refuses a video longer than the configured limit before submitting', async () => {
    stubNetwork()
    const { ctx, tools, dispose } = fakeContext()
    apply(ctx as never, Config({ defaultVideoModel: 'v/vid', maxVideoSeconds: 5 }) as never)
    const generate = tools.find(t => t.name === 'media_generate_video')!
    await expect(generate.execute({ prompt: 'x', duration: 8 }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await dispose()
  })

  it('submits a video job, reports its end to the session, and lists it', async () => {
    stubNetwork()
    const cwd = await mkdtemp(join(tmpdir(), 'media-'))
    const agent = fakeAgent('s1')
    const { ctx, tools, dispose } = fakeContext([agent])
    apply(ctx as never, Config({ defaultVideoModel: 'v/vid', videoPollIntervalMs: 60_000 }) as never)
    const exec = { signal: new AbortController().signal, agent: { session: { id: 's1', header: { cwd } } } }
    const generate = tools.find(t => t.name === 'media_generate_video')!
    const submitted = await generate.execute({ prompt: 'a wave', duration: 4 }, exec) as { id: string; status: string; dir: string; estimate: unknown }
    expect(submitted).toMatchObject({ id: 'job-9', status: 'pending', dir: join(cwd, 'generated-media'), estimate: { min: 0.4, max: 0.4 } })
    const status = tools.find(t => t.name === 'media_video_status')!
    const checked = await status.execute({ job_id: 'job-9' }, exec) as { jobs: { status: string }[] }
    expect(checked.jobs[0]?.status).toBe('failed')
    expect(agent.followed).toHaveLength(1)
    expect(JSON.stringify(agent.followed[0])).toContain('ended with status failed: policy')
    const listed = await status.execute({}, exec) as { jobs: unknown[] }
    expect(listed.jobs).toHaveLength(1)
    await dispose()
  })

  it('asks for approval with a localized cost estimate', async () => {
    stubNetwork()
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ defaultImageModel: 'g/img' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const decision = await hook(
      { name: 'media_generate_image', arguments: { prompts: ['a cat'] }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    ) as { kind: string; displayReason: Record<string, string> }
    expect(decision.kind).toBe('ask')
    expect(decision.displayReason.en).toContain('Estimated cost: about 0.04 USD')
    expect(decision.displayReason.ja).toContain('概算料金：約 0.04 USD')
    expect(decision.displayReason.ja).toContain('/media-approval on')
  })

  it('stops asking in a session the user allowed with /media-approval, and only there', async () => {
    stubNetwork()
    const cwd = await mkdtemp(join(tmpdir(), 'media-'))
    const agent = Object.assign(fakeAgent('s1'), { session: { id: 's1', header: { cwd } } })
    const { ctx, listeners, commands } = fakeContext([agent])
    apply(ctx as never, Config({ defaultImageModel: 'g/img' }) as never)
    const signal = new AbortController().signal
    const run = (name: string, rawInput: string) => commands.find(c => c.name === name)!.handler!({ agent, rawInput, signal })
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<{ kind: string }>
    const call = (session: string) => hook(
      { name: 'media_generate_image', arguments: { prompts: ['a cat'] }, signal, agent: { session: { id: session } } },
      async () => ({ kind: 'allow' }),
    )
    expect((await call('s1')).kind).toBe('ask')
    expect(await run('media-approval', 'on')).toMatchObject({ kind: 'success' })
    expect((await call('s1')).kind).toBe('allow')
    expect((await call('s2')).kind).toBe('ask')
    // A direct command in the allowed session generates without --yes.
    expect((await run('image', 'a red fox')).text).toMatch(/^Saved 1 image/u)
    expect(await run('media-approval', 'off')).toMatchObject({ kind: 'success' })
    expect((await call('s1')).kind).toBe('ask')
    expect(await run('media-approval', 'maybe')).toMatchObject({ kind: 'error' })
  })

  it('leaves other tools, denials, and disabled approval untouched', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ requireApproval: false, defaultImageModel: 'g/img' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const signal = new AbortController().signal
    expect(await hook({ name: 'media_generate_image', arguments: { prompts: ['x'] }, signal }, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    expect(await hook({ name: 'bash', arguments: {}, signal }, async () => ({ kind: 'deny', reason: 'no' }))).toEqual({ kind: 'deny', reason: 'no' })
  })

  it('asks, rather than allows, when the cost cannot be estimated, and refuses invalid calls', async () => {
    vi.stubGlobal('fetch', (async () => new Response('down', { status: 503 })) as unknown as typeof fetch)
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ defaultImageModel: 'g/img' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const signal = new AbortController().signal
    const unpriced = await hook({ name: 'media_generate_image', arguments: { prompts: ['a cat'] }, signal }, async () => ({ kind: 'allow' })) as { kind: string; displayReason: Record<string, string> }
    expect(unpriced.kind).toBe('ask')
    expect(unpriced.displayReason.ja).toContain('料金を概算できませんでした')
    expect(await hook({ name: 'media_generate_image', arguments: { prompts: 'a cat' }, signal }, async () => ({ kind: 'allow' })))
      .toMatchObject({ kind: 'deny' })
  })

  it('denies a generation the cost gate never saw, and joins another policy\'s question', async () => {
    stubNetwork()
    const { ctx, listeners, guards } = fakeContext()
    apply(ctx as never, Config({ defaultImageModel: 'g/img' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const signal = new AbortController().signal
    const skipped = { name: 'media_generate_image', arguments: { prompts: ['a cat'] }, signal }
    expect(guards.map(g => g(skipped)).find(r => r !== undefined)).toContain('without its cost check')
    expect(guards.map(g => g({ name: 'bash', arguments: {}, signal })).every(r => r === undefined)).toBe(true)
    const seen = { name: 'media_generate_image', arguments: { prompts: ['a cat'] }, signal }
    const both = await hook(seen, async () => ({ kind: 'ask', reason: 'hook asks' })) as { kind: string; reason: string }
    expect(both.kind).toBe('ask')
    expect(both.reason).toContain('Estimated cost')
    expect(both.reason).toContain('hook asks')
    expect(guards.every(g => g(seen) === undefined)).toBe(true)
  })

  it('keeps the images saved before a later prompt fails, and says it may be billed', async () => {
    let generated = 0
    vi.stubGlobal('fetch', (async (url: string) => {
      if (url.endsWith('/images/models')) return Response.json({ data: [{ id: 'g/img', name: 'G Image', supported_parameters: {} }] })
      if (url.endsWith('/endpoints')) return Response.json({ data: { endpoints: [] } })
      generated += 1
      const data = generated === 1 ? Buffer.from(PNG) : Buffer.from('not an image')
      return Response.json({ data: [{ b64_json: data.toString('base64') }] })
    }) as unknown as typeof fetch)
    const cwd = await mkdtemp(join(tmpdir(), 'media-'))
    const { ctx, tools, dispose } = fakeContext()
    apply(ctx as never, Config({ defaultImageModel: 'g/img' }) as never)
    const generate = tools.find(t => t.name === 'media_generate_image')!
    const exec = { signal: new AbortController().signal, agent: { session: { id: 's1', header: { cwd } } } }
    const value = await generate.execute({ prompts: ['a cat sitting', 'a cat jumping'] }, exec) as { images: unknown[]; failed?: string }
    expect(value.images).toHaveLength(1)
    expect(value.failed).toContain('image 2 of 2 failed')
    expect(value.failed).toContain('may still have charged')
    await dispose()
  })

  it('always asks before saving prompt notes or sending an image from outside the working directory', async () => {
    stubNetwork()
    const cwd = await mkdtemp(join(tmpdir(), 'media-'))
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ requireApproval: false, defaultImageModel: 'g/img' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; reason?: string }>
    const signal = new AbortController().signal
    const agent = { session: { id: 's1', header: { cwd } } }
    const notes = await hook({ name: 'media_set_prompt_notes', arguments: { model: 'g/img', notes: 'English only.' }, signal, agent }, async () => ({ kind: 'allow' }))
    expect(notes).toMatchObject({ kind: 'ask' })
    expect(notes.reason).toContain('English only.')
    const inside = await hook({ name: 'media_generate_image', arguments: { prompts: ['x'], input_images: ['generated-media/a.png'] }, signal, agent }, async () => ({ kind: 'allow' }))
    expect(inside).toEqual({ kind: 'allow' })
    const outside = await hook({ name: 'media_generate_image', arguments: { prompts: ['x'], input_images: [join(tmpdir(), 'elsewhere.png')] }, signal, agent }, async () => ({ kind: 'allow' }))
    expect(outside.kind).toBe('ask')
    expect(outside.reason).toContain('outside the working directory')
  })

  it('asks for the longest allowed length when the video length is left to a model that could exceed the limit', async () => {
    stubNetwork()
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ defaultVideoModel: 'v/vid', maxVideoSeconds: 5 }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<{ reason: string }>
    const decision = await hook({ name: 'media_generate_video', arguments: { prompt: 'a wave' }, signal: new AbortController().signal }, async () => ({ kind: 'allow' }))
    expect(decision.reason).toContain('Generate a 4-second video')
  })
  /** The turn-tracking listeners of an applied plugin, driven the way DSH drives them. */
  function turns(listeners: Map<string, (...args: never[]) => unknown>) {
    const claimed = listeners.get('agent/inbox/claimed') as unknown as (payload: unknown) => void
    const assemble = listeners.get('system-prompt/assemble') as unknown as (
      assembly: unknown, context: unknown, next: () => Promise<unknown>) => Promise<{ tools: { name: string }[]; sections: { name: string; text: string }[] }>
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; reason?: string }>
    const signal = new AbortController().signal
    return {
      claim: (agent: unknown, turn: number, kind: string) => claimed({ agent, turn, message: { source: { kind } } }),
      /** The tool names and withheld note the agent is offered in its next step. */
      offered: async (agent: unknown) => {
        const tools = ['media_generate_image', 'media_generate_video', 'media_set_prompt_notes', 'media_list_models'].map(name => ({ name }))
        const assembly = await assemble({ tools, sections: [] }, { agent }, async () => ({ tools, sections: [] }))
        return { tools: assembly.tools.map(t => t.name), note: assembly.sections.map(s => s.text).join('') }
      },
      call: (agent: unknown, name = 'media_generate_image', args: unknown = { prompts: ['x'] }) =>
        hook({ name, arguments: args, signal, agent }, async () => ({ kind: 'allow' })),
    }
  }

  it('offers subagents generation only where it needs no confirmation, and never prompt notes', async () => {
    stubNetwork()
    const parent = Object.assign(fakeAgent('p1'), { session: { id: 'p1', header: {} } })
    const { ctx, listeners, commands } = fakeContext([parent])
    apply(ctx as never, Config({ defaultImageModel: 'g/img' }) as never)
    const { claim, offered, call } = turns(listeners)
    const child = { session: { id: 'c1', header: { origin: 'subagent', parentSession: 'p1' } } }
    claim(parent, 1, 'user')
    claim(child, 1, 'user')
    // Confirmation is on and a subagent cannot ask, so it is not offered generation at all.
    const asking = await offered(child)
    expect(asking.tools).toEqual(['media_list_models'])
    expect(asking.note).toContain('not offered to subagents')
    expect((await offered(parent)).tools).toContain('media_generate_image')
    // Bulk work in a conversation that allows generation without asking: every call goes ahead.
    await commands.find(c => c.name === 'media-approval')!.handler!({ agent: parent, rawInput: 'on', signal: new AbortController().signal })
    const allowed = await offered(child)
    expect(allowed.tools).toEqual(['media_generate_image', 'media_generate_video', 'media_list_models'])
    expect(allowed.note).toBe('')
    expect((await call(child)).kind).toBe('allow')
    expect((await call(child, 'media_generate_image', { prompts: ['y'] })).kind).toBe('allow')
  })

  it('generates one request once: by the delegating agent or by its subagents, not both', async () => {
    stubNetwork()
    const parent = Object.assign(fakeAgent('p1'), { session: { id: 'p1', header: {} } })
    const { ctx, listeners } = fakeContext([parent])
    apply(ctx as never, Config({ requireApproval: false, defaultImageModel: 'g/img' }) as never)
    const { claim, offered, call } = turns(listeners)
    const child = (id: string) => ({ session: { id, header: { origin: 'subagent', parentSession: 'p1' } } })
    // The agent generated the request itself, then handed it to a subagent as well: the subagent is not offered it.
    claim(parent, 1, 'user')
    expect((await call(parent)).kind).toBe('allow')
    const late = child('c1')
    claim(late, 1, 'user')
    const duplicate = await offered(late)
    expect(duplicate.tools).not.toContain('media_generate_image')
    expect(duplicate.note).toContain('already generated')
    // A request handed to subagents: every subagent generates its share, and the agent is not offered it too.
    claim(parent, 2, 'user')
    const first = child('c2')
    const second = child('c3')
    claim(first, 1, 'user')
    claim(second, 1, 'user')
    expect((await call(first, 'media_generate_image', { prompts: ['a'] })).kind).toBe('allow')
    expect((await call(second, 'media_generate_image', { prompts: ['b'] })).kind).toBe('allow')
    expect((await call(first, 'media_generate_image', { prompts: ['c'] })).kind).toBe('allow')
    const delegated = await offered(parent)
    expect(delegated.tools).not.toContain('media_generate_image')
    expect(delegated.note).toContain('a subagent you delegated to is generating')
    // The subagents' reports start a turn nobody asked a generation in.
    claim(parent, 3, 'subagent-settled')
    expect((await offered(parent)).tools).not.toContain('media_generate_image')
    // The user's next request is a new one.
    claim(parent, 4, 'user')
    expect((await offered(parent)).tools).toContain('media_generate_image')
    expect((await call(parent)).kind).toBe('allow')
  })

  it('offers no generation in a turn a notice started, and asks for a second one in the user\'s turn', async () => {
    stubNetwork()
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ requireApproval: false, defaultImageModel: 'g/img' }) as never)
    const { claim, offered, call } = turns(listeners)
    const step = listeners.get('agent/pre-step') as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const agent = { session: { id: 's1', header: {} } }
    claim(agent, 1, 'user')
    expect((await call(agent)).kind).toBe('allow')
    await step({ agent, turn: 1, messages: [] }, async () => ({}))
    expect((await call(agent)).kind).toBe('ask')
    claim(agent, 2, 'agent-message')
    const notice = await offered(agent)
    expect(notice.tools).toEqual(['media_set_prompt_notes', 'media_list_models'])
    expect(notice.note).toContain('Nothing was rejected')
    claim(agent, 3, 'user')
    expect((await offered(agent)).note).toBe('')
    expect((await call(agent)).kind).toBe('allow')
    // A turn that took nothing from the inbox (its messages came from a listener) counts as requested.
    await step({ agent, turn: 4, messages: [{ source: { kind: 'goal' } }] }, async () => ({}))
    expect((await call(agent)).kind).toBe('allow')
  })
})
