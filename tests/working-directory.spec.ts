import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { workingDirectory } from '../src/generate.ts'

function ctxWith(services: Record<string, unknown>): Context {
  return { get: (name: string) => services[name] } as unknown as Context
}

describe('workingDirectory', () => {
  const signal = new AbortController().signal
  const agent = { session: { id: 's1', header: { cwd: '/header/cwd' } } }

  it('asks the workingDirectory service when DSH provides it (0.2.1)', async () => {
    const calls: unknown[] = []
    const ctx = ctxWith({ workingDirectory: { ensure: async (a: unknown, s: unknown) => { calls.push([a, s]); return '/moved/cwd' } } })
    expect(await workingDirectory(ctx, { agent, signal } as never)).toBe('/moved/cwd')
    expect(calls).toEqual([[agent, signal]])
  })

  it('falls back to the session header without the service (0.2.0)', async () => {
    expect(await workingDirectory(ctxWith({}), { agent, signal } as never)).toBe('/header/cwd')
  })

  it('falls back to the Host process directory without an agent', async () => {
    const ctx = ctxWith({ workingDirectory: { ensure: async () => '/unused' } })
    expect(await workingDirectory(ctx, { signal } as never)).toBe(process.cwd())
  })
})
