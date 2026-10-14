import { describe, expect, it } from 'vitest'
import { parseImageCommand, parseVideoCommand } from '../src/direct.ts'

describe('direct command parsing', () => {
  it('reads leading options and keeps the prompt as written', () => {
    expect(parseImageCommand('--aspect 16:9 --count 2 --yes 夕焼けの海、 --no-tags は本文')).toEqual({
      confirmed: true,
      args: { prompt: '夕焼けの海、 --no-tags は本文', aspect_ratio: '16:9', count: 2, model: undefined, provider: undefined, resolution: undefined, seed: undefined },
    })
    expect(parseVideoCommand('--duration 8 --audio off a cat, slow pan')).toMatchObject({
      confirmed: false, args: { prompt: 'a cat, slow pan', duration: 8, generate_audio: false },
    })
  })

  it('refuses unknown options, bad values, and an empty prompt', () => {
    expect(() => parseImageCommand('--duration 4 x')).toThrow('unknown option --duration')
    expect(() => parseVideoCommand('--audio maybe x')).toThrow('--audio takes on or off')
    expect(() => parseVideoCommand('--duration four x')).toThrow('whole number')
    expect(() => parseImageCommand('--yes   ')).toThrow('write the prompt')
  })
})
