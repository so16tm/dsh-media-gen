import { describe, expect, it } from 'vitest'
import { agentRequest, directCommand, EMPTY_VALUES } from '../../src/client/card-model.ts'
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
})
