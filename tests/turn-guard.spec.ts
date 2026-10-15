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

  it('ties a subagent to the turn that delegated to it, so the request is generated once', () => {
    const guard = new TurnGuard()
    const root = {}
    const child = {}
    guard.enter(root, 1, [user])
    guard.adopt(child, root)
    expect(guard.duplicate(child)).toBe(false)
    guard.recordDelegated(child)
    expect(guard.standing(root)).toBe('delegated')
    guard.enter(root, 2, [user])
    expect(guard.standing(root)).toBe('first')
    // Adopted once: a later turn of the root does not move the subagent's origin.
    guard.adopt(child, root)
    guard.record(root)
    expect(guard.duplicate(child)).toBe(false)
    const late = {}
    guard.adopt(late, root)
    expect(guard.duplicate(late)).toBe(true)
    expect(guard.duplicate(undefined)).toBe(false)
    guard.adopt({}, undefined)
  })
})
