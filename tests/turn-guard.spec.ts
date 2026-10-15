import { describe, expect, it } from 'vitest'
import { TurnGuard } from '../src/turn-guard.ts'

describe('TurnGuard', () => {
  it('flags the second generation of one turn and resets on the next turn', () => {
    const guard = new TurnGuard()
    const agent = {}
    const other = {}
    expect(guard.repeat(agent)).toBe(false)
    guard.enter(agent, 1)
    guard.enter(other, 1)
    expect(guard.repeat(agent)).toBe(false)
    expect(guard.repeat(other)).toBe(false)
    expect(guard.repeat(agent)).toBe(true)
    guard.enter(agent, 2)
    expect(guard.repeat(agent)).toBe(false)
    expect(guard.repeat(undefined)).toBe(false)
  })
})
