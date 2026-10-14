import { describe, expect, it } from 'vitest'
import { agentRequest, directCommand, EMPTY_VALUES, switchKind } from '../../src/client/card-model.ts'
import { parseImageCommand, parseVideoCommand } from '../../src/direct.ts'
import { activeInput, registerInput } from '../../src/client/media-actions.ts'
import { PICKER_DICTIONARIES, type PickerKey } from '../../src/client/locales.ts'

const t = (key: PickerKey, params: Record<string, string> = {}) =>
  PICKER_DICTIONARIES.ja[key].replace(/\{(\w+)\}/gu, (m, name: string) => params[name] ?? m)

describe('generation card', () => {
  const video = { ...EMPTY_VALUES, kind: 'video' as const, content: ' 夜の海に浮かぶ灯籠 ', model: 'v/vid', duration: '8', audio: 'off' as const }

  it('asks the agent with only the fields the user filled', () => {
    expect(agentRequest(video, t, 'V Video')).toBe('動画を生成してください。\n内容：夜の海に浮かぶ灯籠\nモデル：V Video (v/vid)\n長さ：8 秒\n音声：なし')
    expect(agentRequest({ ...EMPTY_VALUES, content: 'a fox', aspect: '1:1', duration: '8' }, t)).toBe('画像を生成してください。\n内容：a fox\n縦横比：1:1')
  })

  it('builds the direct command with the content last and unchanged', () => {
    expect(directCommand(video)).toBe('/video --yes --model v/vid --duration 8 --audio off 夜の海に浮かぶ灯籠')
    expect(directCommand({ ...EMPTY_VALUES, content: 'a fox', resolution: '1K' })).toBe('/image --yes --resolution 1K a fox')
  })
  it('carries input images into both forms and across a kind switch', () => {
    const image = { ...EMPTY_VALUES, content: 'make it blue', images: ['/w/media/a b.png'] }
    const line = directCommand(image)
    expect(line).toBe('/image --yes --image "/w/media/a b.png" make it blue')
    expect(parseImageCommand(line.slice('/image '.length)).args).toMatchObject({ input_images: ['/w/media/a b.png'], prompt: 'make it blue' })
    expect(agentRequest(image, t)).toBe('画像を生成してください。\n内容：make it blue\n入力画像：/w/media/a b.png')
    const video = switchKind(image, 'video')
    expect(video).toMatchObject({ kind: 'video', content: 'make it blue', images: [], firstFrame: '/w/media/a b.png' })
    expect(parseVideoCommand(directCommand(video).slice('/video '.length)).args).toMatchObject({ first_frame: '/w/media/a b.png' })
    expect(switchKind(video, 'image').images).toEqual(['/w/media/a b.png'])
  })
})

describe('media actions', () => {
  it('acts on the most recently mounted chat input', () => {
    const noop = { compose: () => {}, setDraft: () => {} }
    const offA = registerInput({ sessionId: 'a', ...noop })
    const offB = registerInput({ sessionId: 'b', ...noop })
    expect(activeInput()?.sessionId).toBe('b')
    offB()
    expect(activeInput()?.sessionId).toBe('a')
    offA()
    expect(activeInput()).toBeUndefined()
  })
})

describe('offered models', () => {
  const listing = { providers: [{ id: 'or', name: 'OR', stale: false, models: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] }], default: null }
  it('limits to the configured subset but keeps the current and default ids', async () => {
    const { offeredOf } = await import('../../src/client/api.ts')
    expect(offeredOf(listing, [], ['b']).map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(offeredOf(listing, ['c'], ['b', null]).map(m => m.id)).toEqual(['b', 'c'])
    expect(offeredOf(listing, ['c'], ['gone']).map(m => m.id)).toEqual(['c', 'gone'])
  })
})
