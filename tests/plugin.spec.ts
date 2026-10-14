import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.ts'

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

function fakeContext(agents: FakeAgent[] = []) {
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const tools: { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }[] = []
  const disposers: (() => unknown)[] = []
  const commands: { name: string; handler?(invocation: unknown): Promise<{ kind: string; text: string }> }[] = []
  const services: Record<string, unknown> = {
    credentials: { resolve: async () => ({ value: 'sk-or-k' }) },
    agents: { get: (id: string) => agents.find(a => a.session.id === id) },
    commands: { register: (command: { name: string }) => { commands.push(command) } },
  }
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'openrouter', name: 'OpenRouter' }],
      listConfigurableProviders: () => [],
    },
    tools: { register: (tool: (typeof tools)[number]) => { tools.push(tool) } },
    on: (name: string, fn: (...args: never[]) => unknown) => { listeners.set(name, fn) },
    get: (name: string) => services[name],
    effect: (fn: () => () => unknown) => { disposers.push(fn()) },
    inject: (deps: string[], fn: (c: Record<string, unknown>) => void) => {
      if (deps.every(d => services[d] !== undefined)) fn(Object.fromEntries(deps.map(d => [d, services[d]])))
    },
    logger: { warn: () => {} },
  }
  return { ctx, listeners, tools, commands, dispose: async () => { for (const d of disposers) await d() } }
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
    expect(commands.map(c => c.name)).toEqual(['media-model', 'image', 'video', 'media-jobs'])
    const preview = await run('image', '--model g/img a red fox')
    expect(preview).toMatchObject({ kind: 'success' })
    expect(preview.text).toContain('about 0.04 USD')
    expect(preview.text).toContain('--yes')
    const saved = await run('image', '--model g/img --yes a red fox')
    expect(saved.text).toMatch(/^Saved 1 image\(s\) from g\/img/u)
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
      .toMatchObject({ model: 'v/vid', notes: 'English only; one sentence per shot.', durable: false })
    const listing = await tool('media_list_models').execute({ kind: 'video' }, exec) as { providers: { videoModels: { id: string; promptNotes?: string }[] }[] }
    expect(listing.providers[0]?.videoModels[0]).toMatchObject({ id: 'v/vid', promptNotes: 'English only; one sentence per shot.' })
    expect(await tool('media_get_prompt_notes').execute({}, exec)).toMatchObject({ notes: [{ model: 'v/vid' }] })
    await expect(tool('media_set_prompt_notes').execute({ model: 'v/vid', notes: 'x'.repeat(2001) }, exec)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(await tool('media_set_prompt_notes').execute({ model: 'v/vid', notes: ' ' }, exec)).toMatchObject({ deleted: true })
    expect(await tool('media_get_prompt_notes').execute({ model: 'v/vid' }, exec)).toMatchObject({ notes: [] })
    await dispose()
  })

  it('uses the model chosen with /media-model for the calling session only', async () => {
    stubNetwork()
    const cwd = await mkdtemp(join(tmpdir(), 'media-'))
    const { ctx, tools, commands, dispose } = fakeContext([fakeAgent('s1')])
    apply(ctx as never, Config({}) as never)
    const command = commands.find(c => c.name === 'media-model')!
    const signal = new AbortController().signal
    expect(await command.handler!({ agent: fakeAgent('s1'), rawInput: ' video v/vid', signal })).toMatchObject({ kind: 'success' })
    const generate = tools.find(t => t.name === 'media_generate_video')!
    const submitted = await generate.execute({ prompt: 'a wave', duration: 4 }, { signal, agent: { session: { id: 's1', header: { cwd } } } }) as { model: string }
    expect(submitted.model).toBe('v/vid')
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
      { name: 'media_generate_image', arguments: { prompt: 'a cat' }, signal: new AbortController().signal },
      async () => ({ kind: 'allow' }),
    ) as { kind: string; displayReason: Record<string, string> }
    expect(decision.kind).toBe('ask')
    expect(decision.displayReason.en).toContain('Estimated cost: about 0.04 USD')
    expect(decision.displayReason.ja).toContain('概算料金：約 0.04 USD')
  })

  it('leaves other tools, denials, and disabled approval untouched', async () => {
    const { ctx, listeners } = fakeContext()
    apply(ctx as never, Config({ requireApproval: false, defaultImageModel: 'g/img' }) as never)
    const hook = listeners.get('tools/pre-execute') as unknown as (exec: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const signal = new AbortController().signal
    expect(await hook({ name: 'media_generate_image', arguments: { prompt: 'x' }, signal }, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
    expect(await hook({ name: 'bash', arguments: {}, signal }, async () => ({ kind: 'deny', reason: 'no' }))).toEqual({ kind: 'deny', reason: 'no' })
  })
})
