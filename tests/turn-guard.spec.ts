import { describe, expect, it } from 'vitest'
import { TurnGuard } from '../src/turn-guard.ts'

const user = { source: { kind: 'user' } }
const notice = { source: { kind: 'subagent-settled' } }

describe('TurnGuard', () => {
  it('flags the second generation of one request and resets when the user writes again', () => {
    const guard = new TurnGuard()
    const agent = {}
    const other = {}
    expect(guard.repeat(agent)).toBe(false)
    guard.enter(agent, [user])
    guard.enter(other, [user])
    expect(guard.repeat(agent)).toBe(false)
    expect(guard.repeat(other)).toBe(false)
    expect(guard.repeat(agent)).toBe(true)
    guard.enter(agent, [user])
    expect(guard.repeat(agent)).toBe(false)
    expect(guard.repeat(undefined)).toBe(false)
  })

  it('keeps a turn started by a notice in the request before it', () => {
    const guard = new TurnGuard()
    const agent = {}
    guard.enter(agent, [user])
    expect(guard.repeat(agent)).toBe(false)
    guard.enter(agent, [notice])
    guard.enter(agent, [])
    expect(guard.repeat(agent)).toBe(true)
  })
})
