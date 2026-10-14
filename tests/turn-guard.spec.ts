import { describe, expect, it } from 'vitest'
import { TurnGuard } from '../src/turn-guard.ts'

const user = { source: { kind: 'user' } }
const notice = { source: { kind: 'subagent-settled' } }

describe('TurnGuard', () => {
  it('tells the first generation of a user turn from later ones, per agent and per turn', () => {
    const guard = new TurnGuard()
    const agent = {}
    const other = {}
    expect(guard.standing(agent)).toBe('unknown')
    guard.enter(agent, 1, [user])
    guard.enter(other, 1, [user])
    expect(guard.standing(agent)).toBe('first')
    guard.record(agent)
    guard.enter(agent, 1, [])
    expect(guard.standing(agent)).toBe('repeat')
    expect(guard.standing(other)).toBe('first')
    guard.enter(agent, 2, [user])
    expect(guard.standing(agent)).toBe('first')
    expect(guard.standing(undefined)).toBe('unknown')
  })

  it('marks a turn a notice started as unrequested until the user writes in it', () => {
    const guard = new TurnGuard()
    const agent = {}
    guard.enter(agent, 1, [notice])
    expect(guard.standing(agent)).toBe('unrequested')
    guard.enter(agent, 1, [user])
    expect(guard.standing(agent)).toBe('first')
  })

  it('treats a goal round or a schedule as a request', () => {
    const guard = new TurnGuard()
    const agent = {}
    guard.enter(agent, 1, [{ source: { kind: 'goal' } }])
    expect(guard.standing(agent)).toBe('first')
    guard.enter(agent, 2, [{ source: { kind: 'schedule' } }])
    expect(guard.standing(agent)).toBe('first')
  })
})
