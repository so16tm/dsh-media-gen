import { describe, expect, it } from 'vitest'
import { fileUrl, imagePathsOf, imagesOf, jobIdOf, promptOf, textOf, videoJobOf } from '../../src/client/media-model.ts'

describe('media view model', () => {
  it('reads saved images from metadata, or from the result text', () => {
    expect(imagesOf({ images: [{ path: '/w/a.png' }] }, '')).toEqual(['/w/a.png'])
    const tool = 'Generated 2 image(s) with g/img (provider openrouter).\n- C:\\w\\a b.png (image/png, 10 bytes)\n- /w/b.jpg (image/jpeg, 3 bytes)\nCost: 0.04 USD.'
    expect(imagesOf(undefined, tool)).toEqual(['C:\\w\\a b.png', '/w/b.jpg'])
    expect(imagePathsOf('Saved 1 image(s) from g/img (0.04 USD):\n- /w/c.webp')).toEqual(['/w/c.webp'])
    expect(imagePathsOf('- /w/notes.txt')).toEqual([])
    expect(fileUrl('/w/a b.png')).toBe('api/media-gen.file?path=%2Fw%2Fa%20b.png')
  })

  it('reads the video job id and the prompt', () => {
    expect(videoJobOf({ jobId: 'job-1' }, '')).toBe('job-1')
    expect(jobIdOf('Video job job-9 (v/vid, provider openrouter) is queued.')).toBe('job-9')
    expect(videoJobOf(null, 'Nothing was submitted')).toBeUndefined()
    expect(textOf([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb')
    expect(promptOf('{"prompt":"a fox"}')).toBe('a fox')
    expect(promptOf('{"prompt":')).toBeUndefined()
  })
})
