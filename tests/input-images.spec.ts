import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseImageCommand, parseVideoCommand } from '../src/direct.ts'
import { inputPaths, loadInputImage, MAX_INPUT_IMAGES } from '../src/input-images.ts'
import { OpenRouterAdapter } from '../src/openrouter.ts'
import { estimateVideoCost, parseVideoModels, validateVideoInputs } from '../src/video.ts'

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function recorder(body: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return Response.json(body, { status: 200 })
  }) as unknown as typeof fetch
  return { calls, adapter: new OpenRouterAdapter({ baseURL: 'https://openrouter.ai/api/v1', apiKey: 'k', fetch: impl, timeoutMs: 1000 }) }
}

describe('input images', () => {
  it('trims, de-duplicates, and limits paths', () => {
    expect(inputPaths([' a.png', 'a.png', '', 'b.png'], 'input_images')).toEqual(['a.png', 'b.png'])
    expect(inputPaths(undefined, 'x')).toEqual([])
    expect(() => inputPaths(Array.from({ length: MAX_INPUT_IMAGES + 1 }, (_, i) => `${i}.png`), 'input_images')).toThrow('at most')
  })

  it('reads an image relative to the working directory as a data URL and refuses other files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-input-'))
    await writeFile(join(dir, 'cat.png'), PNG)
    await writeFile(join(dir, 'note.txt'), 'hello')
    const image = await loadInputImage('cat.png', dir)
    expect(image).toMatchObject({ path: join(dir, 'cat.png'), mediaType: 'image/png', bytes: PNG.byteLength })
    expect(image.dataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    await expect(loadInputImage('note.txt', dir)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(loadInputImage('missing.png', dir)).rejects.toThrow('not found')
    await expect(loadInputImage('cat.png', dir, 4)).rejects.toThrow('limit')
  })

  it('hands WebP to the imageCompat service and keeps the original when it fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'media-input-'))
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2])
    await writeFile(join(dir, 'cat.webp'), webp)
    await writeFile(join(dir, 'cat.png'), PNG)
    const calls: string[] = []
    const compat = {
      needsConversion: (type: string) => type === 'image/webp',
      toCompatible: async (_data: Uint8Array, type: string) => { calls.push(type); return { data: PNG, mediaType: 'image/png' } },
    }
    expect(await loadInputImage('cat.webp', dir, undefined, compat)).toMatchObject({
      mediaType: 'image/png', bytes: PNG.byteLength, dataUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    })
    expect(await loadInputImage('cat.png', dir, undefined, compat)).toMatchObject({ mediaType: 'image/png' })
    expect(calls).toEqual(['image/webp'])
    const failing = { ...compat, toCompatible: async () => { throw new Error('boom') } }
    expect(await loadInputImage('cat.webp', dir, undefined, failing)).toMatchObject({ mediaType: 'image/webp', bytes: webp.byteLength })
    expect(await loadInputImage('cat.webp', dir)).toMatchObject({ mediaType: 'image/webp' })
  })

  it('sends references and frames in the documented request shapes', async () => {
    const image = recorder({ data: [{ b64_json: Buffer.from(PNG).toString('base64') }] })
    await image.adapter.generateImage({ model: 'm', prompt: 'p', params: {}, inputReferences: ['data:image/png;base64,AA'] })
    expect(JSON.parse(image.calls[0]?.init.body as string)).toEqual({
      model: 'm', prompt: 'p', input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }],
    })
    const video = recorder({ id: 'job-1', status: 'pending' })
    await video.adapter.submitVideo({
      model: 'v', prompt: 'p', params: {},
      frameImages: [{ url: 'data:a', frameType: 'first_frame' }, { url: 'data:b', frameType: 'last_frame' }],
      inputReferences: ['data:c'],
    })
    expect(JSON.parse(video.calls[0]?.init.body as string)).toEqual({
      model: 'v', prompt: 'p',
      frame_images: [
        { type: 'image_url', image_url: { url: 'data:a' }, frame_type: 'first_frame' },
        { type: 'image_url', image_url: { url: 'data:b' }, frame_type: 'last_frame' },
      ],
      input_references: [{ type: 'image_url', image_url: { url: 'data:c' } }],
    })
  })

  it('refuses a frame the video model does not list and counts per-image prices', () => {
    const [firstOnly, silent] = parseVideoModels({ data: [
      { id: 'a', name: 'A', supported_frame_images: ['first_frame'], pricing_skus: { generate: '0.10', input_image: '0.01' } },
      { id: 'b', name: 'B' },
    ] })
    expect(validateVideoInputs(firstOnly!, { prompt: 'p', first_frame: ' x.png ' }, [])).toEqual({ first: 'x.png', references: [] })
    expect(() => validateVideoInputs(firstOnly!, { prompt: 'p', last_frame: 'y.png' }, [])).toThrow('not last_frame')
    expect(validateVideoInputs(silent!, { prompt: 'p', last_frame: 'y.png' }, ['r.png'])).toEqual({ last: 'y.png', references: ['r.png'] })
    const cost = estimateVideoCost(firstOnly!, undefined, undefined, 2)
    expect(cost?.min).toBeCloseTo(0.12)
    expect(cost?.max).toBeCloseTo(0.12)
  })

  it('reads input options from /image and /video lines, quoted paths included', () => {
    expect(parseImageCommand('--image a.png --image "my pics/b.png" make it blue').args).toMatchObject({
      prompt: 'make it blue', input_images: ['a.png', 'my pics/b.png'],
    })
    expect(parseVideoCommand('--first a.png --last b.png --ref c.png walk').args).toMatchObject({
      prompt: 'walk', first_frame: 'a.png', last_frame: 'b.png', reference_images: ['c.png'],
    })
    expect(() => parseVideoCommand('--first a.png --first b.png walk')).toThrow('given twice')
  })
})
