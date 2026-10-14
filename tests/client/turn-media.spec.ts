import { describe, expect, it } from 'vitest'
import { turnImages, turnMediaDefinition, TURN_MEDIA_KEY } from '../../src/client/turn-media.ts'

type Event = Parameters<typeof turnMediaDefinition.match>[0]

function run(events: Event[]) {
  let state: ReturnType<typeof turnMediaDefinition.start> | undefined
  for (const event of events) {
    const match = turnMediaDefinition.match(event)
    if (match === null) continue
    state = match.role === 'start' ? turnMediaDefinition.start(undefined, { event }) : turnMediaDefinition.update({ state: state! }, { event })
  }
  return turnMediaDefinition.buildLocationData({ state }, 'turn', null)
}

const result = (seq: number, callId: string, meta: unknown, isError = false): Event => ({
  type: 'tool/result', seq, surfaceOp: 'append', data: { turn: 1, meta, message: { isError, source: { callId } } },
})

describe('turn media', () => {
  it('collects the images of successful image tool results in the turn', () => {
    const data = run([
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, data: { turn: 1, callId: 'c1', name: 'media_generate_image' } },
      { type: 'tool/call', seq: 3, data: { turn: 1, callId: 'c2', name: 'read' } },
      result(4, 'c1', { model: 'm', images: [{ path: '/w/a.png', mediaType: 'image/png' }] }),
      result(5, 'c2', { images: [{ path: '/w/not-ours.png' }] }),
      { type: 'tool/call', seq: 6, data: { turn: 1, callId: 'c3', name: 'media_generate_image' } },
      result(7, 'c3', { images: [{ path: '/w/b.png' }] }, true),
    ])
    expect(data).toEqual({ kind: 'turn', turn: 1, key: TURN_MEDIA_KEY, value: { images: [{ seq: 4, path: '/w/a.png' }] } })
    const owner = { seq: 9, openFile: () => {}, turn: { data: { get: (key: string) => key === TURN_MEDIA_KEY ? data?.value : undefined } } }
    expect(turnImages(owner)).toEqual(['/w/a.png'])
    expect(turnImages({ ...owner, turn: { ...owner.turn, end: { seq: 3 } } })).toEqual([])
  })

  it('reads the result text of calls saved before the metadata existed', () => {
    const data = run([
      { type: 'turn/start', seq: 1, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, data: { turn: 1, callId: 'c1', name: 'media_generate_image' } },
      { type: 'tool/result', seq: 3, surfaceOp: 'append', data: { turn: 1, message: { source: { callId: 'c1' }, content: [
        { type: 'text', text: 'Generated 1 image(s) with m (provider p).\n- /w/old.png (image/png, 10 bytes)\nCost: 0.01 USD.' },
      ] } } },
    ])
    expect(data?.value).toEqual({ images: [{ seq: 3, path: '/w/old.png' }] })
  })

  it('publishes nothing for a turn without images', () => {
    expect(run([{ type: 'turn/start', seq: 1, data: { turn: 1 } }])).toBeNull()
  })
})
