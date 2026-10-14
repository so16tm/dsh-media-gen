import { describe, expect, it } from 'vitest'
import { OpenRouterAdapter } from '../src/openrouter.ts'
import {
  estimateVideoCost, parseVideoJob, parseVideoModels, sniffVideo, validateVideoParams, type VideoModel,
} from '../src/video.ts'

const MP4 = Uint8Array.from([0, 0, 0, 0x18, ...new TextEncoder().encode('ftypisom'), 1, 2, 3])

const LISTING = {
  data: [
    {
      id: 'google/veo-3.1',
      canonical_slug: 'google/veo-3.1',
      name: 'Veo 3.1',
      generate_audio: true,
      seed: null,
      pricing_skus: { video_second_720p: '0.20', video_second_1080p: '0.40', bogus: 'n/a' },
      supported_resolutions: ['720p', '1080p'],
      supported_aspect_ratios: ['16:9', '9:16'],
      supported_sizes: null,
      supported_durations: [4, 8],
      supported_frame_images: ['first_frame'],
    },
    { id: 'flat/video', name: '', pricing_skus: { generate: '0.50' }, generate_audio: false, seed: false, supported_durations: null },
    { name: 'no id' },
  ],
}

function model(id: string): VideoModel {
  return parseVideoModels(LISTING).find(m => m.id === id)!
}

describe('parseVideoModels', () => {
  it('keeps declared lists, drops unparsable prices, and leaves unknown flags undefined', () => {
    const [veo, flat, ...rest] = parseVideoModels(LISTING)
    expect(rest).toEqual([])
    expect(veo).toMatchObject({ durations: [4, 8], resolutions: ['720p', '1080p'], audio: true, pricingSkus: { video_second_720p: 0.2, video_second_1080p: 0.4 } })
    expect(veo?.seed).toBeUndefined()
    expect(veo?.sizes).toBeUndefined()
    expect(flat).toMatchObject({ name: 'flat/video', audio: false, seed: false, pricingSkus: { generate: 0.5 } })
    expect(flat?.durations).toBeUndefined()
  })
})

describe('validateVideoParams', () => {
  it('canonicalizes listed values and rejects others before sending', () => {
    expect(validateVideoParams(model('google/veo-3.1'), { prompt: 'x', resolution: '1080P', duration: 8, generate_audio: true }))
      .toEqual({ resolution: '1080p', duration: 8, generate_audio: true })
    expect(() => validateVideoParams(model('google/veo-3.1'), { prompt: 'x', duration: 5 })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' }))
    expect(() => validateVideoParams(model('google/veo-3.1'), { prompt: 'x', aspect_ratio: '1:1' })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' }))
    expect(() => validateVideoParams(model('flat/video'), { prompt: 'x', generate_audio: true })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' }))
    expect(() => validateVideoParams(model('flat/video'), { prompt: 'x', seed: 1 })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' }))
  })

  it('does not enforce lists the listing leaves empty', () => {
    expect(validateVideoParams(model('flat/video'), { prompt: 'x', duration: 7, resolution: '4K' })).toEqual({ duration: 7, resolution: '4K' })
  })
})

describe('estimateVideoCost', () => {
  it('multiplies the matching per-second tier by the duration', () => {
    expect(estimateVideoCost(model('google/veo-3.1'), 8, '1080p')).toEqual({ min: 3.2, max: 3.2 })
  })

  it('returns a range when the tier or the duration is open', () => {
    expect(estimateVideoCost(model('google/veo-3.1'), 4)).toEqual({ min: 0.8, max: 1.6 })
    expect(estimateVideoCost(model('google/veo-3.1'))).toEqual({ min: 0.8, max: 3.2 })
  })

  it('uses flat per-video prices and gives up on unknown SKU names', () => {
    expect(estimateVideoCost(model('flat/video'), 5)).toEqual({ min: 0.5, max: 0.5 })
    expect(estimateVideoCost({ ...model('flat/video'), pricingSkus: { tokens: 0.001 } })).toBeUndefined()
    expect(estimateVideoCost({ ...model('google/veo-3.1'), durations: [] })).toBeUndefined()
  })
})

describe('parseVideoJob', () => {
  it('reads status, outputs, cost, and errors', () => {
    expect(parseVideoJob({ id: 'j', status: 'completed', unsigned_urls: ['a', 'b'], usage: { cost: 0.25 } }))
      .toEqual({ id: 'j', status: 'completed', outputs: 2, costUsd: 0.25 })
    expect(parseVideoJob({ id: 'j', status: 'completed' })?.outputs).toBe(1)
    expect(parseVideoJob({ id: 'j', status: 'weird' })?.status).toBe('pending')
    expect(parseVideoJob({ id: 'j', status: 'failed', error: 'policy' })).toMatchObject({ status: 'failed', error: 'policy', outputs: 0 })
    expect(parseVideoJob({ status: 'pending' })).toBeUndefined()
  })
})

describe('sniffVideo', () => {
  it('recognizes MP4 and WebM and rejects other data', () => {
    expect(sniffVideo(MP4)).toEqual({ mediaType: 'video/mp4', extension: 'mp4' })
    expect(sniffVideo(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0]))).toEqual({ mediaType: 'video/webm', extension: 'webm' })
    expect(sniffVideo(new TextEncoder().encode('<html>'))).toBeUndefined()
  })
})

describe('OpenRouterAdapter video calls', () => {
  function adapter(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = []
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return handler(url, init)
    }) as unknown as typeof fetch
    return { calls, adapter: new OpenRouterAdapter({ baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', fetch: impl, timeoutMs: 1000 }) }
  }

  it('submits once with only the validated parameters', async () => {
    const { calls, adapter: a } = adapter(() => Response.json({ id: 'job-1', polling_url: '/api/v1/videos/job-1', status: 'pending' }, { status: 202 }))
    expect(await a.submitVideo({ model: 'google/veo-3.1', prompt: 'a wave', params: { duration: 4 } }))
      .toEqual({ id: 'job-1', status: 'pending', outputs: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/videos')
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ model: 'google/veo-3.1', prompt: 'a wave', duration: 4 })
  })

  it('downloads content with the credential and enforces the size limit', async () => {
    const { calls, adapter: a } = adapter(() => new Response(MP4, { headers: { 'content-type': 'video/mp4' } }))
    const result = await a.downloadVideo('job 1', 0, 1000)
    expect(result).toEqual({ data: MP4, contentType: 'video/mp4' })
    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/videos/job%201/content?index=0')
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test')
    await expect(a.downloadVideo('job-1', 0, 4)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('classifies a missing job and redacts the key', async () => {
    const { adapter: a } = adapter(() => Response.json({ error: { code: 404, message: 'no job for sk-or-test' } }, { status: 404 }))
    const error = await a.getVideoJob('gone').then(() => new Error('resolved'), (e: unknown) => e as Error)
    expect(error).toMatchObject({ status: 404 })
    expect(error.message).not.toContain('sk-or-test')
  })
})

describe('cent-priced SKUs', () => {
  it('reads cents as USD before estimating', () => {
    const [grok] = parseVideoModels({ data: [{
      id: 'x-ai/grok-imagine-video-lite', name: 'Grok', supported_durations: [1, 5],
      pricing_skus: { cents_per_video_output_second_480p: '2', cents_per_video_output_second_720p: '4' },
    }] })
    expect(grok?.pricingSkus).toEqual({ cents_per_video_output_second_480p: 0.02, cents_per_video_output_second_720p: 0.04 })
    expect(estimateVideoCost(grok!, 1, '480p')).toEqual({ min: 0.02, max: 0.02 })
  })
})
