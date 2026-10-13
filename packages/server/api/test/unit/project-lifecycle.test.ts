import { beforeEach, describe, expect, it, vi } from 'vitest'
import { projectLifecycle } from '../../src/app/project/project-lifecycle'
import { system } from '../../src/app/helper/system/system'

const state = vi.hoisted(() => { const keys: string[] = []; return { active: true, tail: Promise.resolve(), keys } })
vi.mock('../../src/app/project/project-repo', () => ({ projectRepo: () => ({
    findOneBy: async () => state.active ? { id: 'center', type: 'TEAM' } : null,
}) }))
vi.mock('../../src/app/database/redis-connections', () => ({ distributedLock: () => ({
    runExclusive: async ({ key, fn }: { key: string, fn: () => Promise<unknown> }) => {
        state.keys.push(key)
        const previous = state.tail
        let release = () => {}
        state.tail = new Promise<void>(resolve => { release = resolve })
        await previous
        try { return await fn() } finally { release() }
    },
}) }))

beforeEach(() => { state.active = true; state.tail = Promise.resolve(); state.keys = [] })

describe('Command Center admission versus archive', () => {
    it('rechecks archived state after waiting so a racing trigger/run cannot enter', async () => {
        let releaseArchive = () => {}
        const barrier = new Promise<void>(resolve => { releaseArchive = resolve })
        const admitted = vi.fn()
        const archive = projectLifecycle.runWhileActive({ projectId: 'center', log: system.globalLogger(), operation: async () => {
            await barrier
            state.active = false
        } })
        const enable = projectLifecycle.runWhileActive({ projectId: 'center', log: system.globalLogger(), operation: admitted })
        const rejected = expect(enable).rejects.toThrow()
        releaseArchive()
        await archive
        await rejected
        expect(admitted).not.toHaveBeenCalled()
        expect(state.keys).toEqual(['project-lifecycle-center', 'project-lifecycle-center'])
    })

    it('finishes admission before archive checks, making pending work observable', async () => {
        let releaseAdmission = () => {}
        const barrier = new Promise<void>(resolve => { releaseAdmission = resolve })
        const events: string[] = []
        const admission = projectLifecycle.runWhileActive({ projectId: 'center', log: system.globalLogger(), operation: async () => {
            events.push('admission')
            await barrier
            events.push('persist queued run')
        } })
        const archive = projectLifecycle.runWhileActive({ projectId: 'center', log: system.globalLogger(), operation: async () => {
            events.push('archive counts unfinished runs')
        } })
        releaseAdmission()
        await Promise.all([admission, archive])
        expect(events).toEqual(['admission', 'persist queued run', 'archive counts unfinished runs'])
    })
})
