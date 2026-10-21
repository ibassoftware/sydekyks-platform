import { ActionContext, CreateWaitpointHook, InputPropertyMap, PieceAuthProperty } from '@activepieces/pieces-framework'
import { ExecutionType, PauseType } from '@activepieces/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareLegacyTodo } from '../../src/lib/piece-context/legacy-todo'

type TodoContext = ActionContext<PieceAuthProperty, InputPropertyMap>

function fixture(overrides: Partial<TodoContext> = {}) {
    const waitForWaitpoint = vi.fn()
    const createWaitpoint = vi.fn().mockResolvedValue({
        id: 'waitpoint-1',
        buildResumeUrl: () => 'http://localhost/api/v1/flow-runs/run-1/waitpoints/waitpoint-1',
    })
    const context = {
        executionType: ExecutionType.BEGIN,
        propsValue: { taskId: 'existing-task' },
        server: { apiUrl: 'http://internal/api/', publicUrl: 'http://localhost/api/', token: 'scoped-engine-token' },
        run: { id: 'run-1', createWaitpoint: vi.fn(), waitForWaitpoint },
        ...overrides,
    } as unknown as TodoContext
    return {
        context,
        createTodoWaitpoint: createWaitpoint as CreateWaitpointHook,
        createWaitpoint,
        waitForWaitpoint,
        pieceName: '@activepieces/piece-todos',
        actionName: 'createTodoAndWait',
        waitpointKey: 'loop-1/0/step-1',
        isSingleStepTest: false,
    }
}

describe('catalogue Todo durable runtime bridge', () => {
    const fetchMock = vi.fn()
    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock)
        fetchMock.mockReset().mockResolvedValue(new Response('{}', { status: 200 }))
    })
    afterEach(() => vi.unstubAllGlobals())

    it('creates the durable wait before the old action can expose a link, then binds its result', async () => {
        const input = fixture()
        const bridge = await prepareLegacyTodo(input)
        expect(input.createWaitpoint).toHaveBeenCalledWith({ type: 'WEBHOOK', version: 'V1', responseToSend: {} })
        expect(bridge.context.generateResumeUrl!({ queryParams: {} })).toContain('/waitpoints/waitpoint-1')
        bridge.context.run.pause!({ pauseMetadata: { type: PauseType.WEBHOOK, response: {} } })
        expect(input.waitForWaitpoint).toHaveBeenCalledWith('waitpoint-1')
        await bridge.complete({ id: 'new-task' })
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][0]).toBe('http://internal/api/v1/todos/new-task/wait')
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ flowRunId: 'run-1', waitpointId: 'waitpoint-1' })
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer scoped-engine-token')
    })

    it('binds the selected existing task, including one created in another run of this project', async () => {
        const bridge = await prepareLegacyTodo({ ...fixture(), actionName: 'wait_for_approval' })
        await bridge.complete(undefined)
        expect(fetchMock.mock.calls[0][0]).toBe('http://internal/api/v1/todos/existing-task/wait')
    })

    it('keeps the wait-existing single-step preview read-only', async () => {
        const input = { ...fixture(), actionName: 'wait_for_approval', isSingleStepTest: true }
        const bridge = await prepareLegacyTodo(input)
        expect(bridge.context).toBe(input.context)
        await bridge.complete({ status: 'Approved' })
        expect(input.createWaitpoint).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does not re-register, pause or debit anything when the legacy action resumes', async () => {
        const input = fixture({ executionType: ExecutionType.RESUME })
        const bridge = await prepareLegacyTodo(input)
        expect(bridge.context).toBe(input.context)
        await bridge.complete({ status: 'Approved', message: 'Looks good' })
        expect(input.createWaitpoint).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('does not create a task after the run refuses to suspend', async () => {
        const input = fixture()
        input.createWaitpoint.mockRejectedValue(new Error('Action runs cannot suspend'))
        await expect(prepareLegacyTodo(input)).rejects.toThrow('cannot suspend')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('fails instead of leaving a successful-looking unbound wait when the old action has no task ID', async () => {
        const bridge = await prepareLegacyTodo(fixture())
        await expect(bridge.complete({})).rejects.toThrow('task ID')
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('propagates a server validation denial instead of treating it as a paused success', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'VALIDATION', params: { message: 'Task belongs to another project' } }), { status: 400 }))
        const bridge = await prepareLegacyTodo(fixture())
        await expect(bridge.complete({ id: 'foreign-task' })).rejects.toThrow('another project')
    })

    it('identifies retried create calls deterministically but separates run, step and loop iteration', async () => {
        const input = { ...fixture(), actionName: 'createTodo' }
        const first = await prepareLegacyTodo(input)
        const repeat = await prepareLegacyTodo(input)
        const otherStep = await prepareLegacyTodo({ ...input, waitpointKey: 'loop-1/0/step-2' })
        const otherIteration = await prepareLegacyTodo({ ...input, waitpointKey: 'loop-1/1/step-1' })
        const otherRun = await prepareLegacyTodo({ ...input, context: { ...input.context, run: { ...input.context.run, id: 'run-2' } } })
        const url = (bridge: Awaited<ReturnType<typeof prepareLegacyTodo>>) => bridge.context.generateResumeUrl!({ queryParams: {} })
        expect(url(first)).toBe(url(repeat))
        expect(new Set([url(first), url(otherStep), url(otherIteration), url(otherRun)]).size).toBe(4)
        expect(url(first)).toMatch(/\/run-1\/requests\/todo-[a-f0-9]{64}$/)
        expect(input.createWaitpoint).not.toHaveBeenCalled()
    })

    it.each([
        { pieceName: '@other/piece-todos', actionName: 'createTodoAndWait' },
        { pieceName: '@activepieces/piece-todos', actionName: 'future_action' },
    ])('does not intercept another piece or unknown future action: $pieceName/$actionName', async (identity) => {
        const input = { ...fixture(), ...identity }
        const bridge = await prepareLegacyTodo(input)
        expect(bridge.context).toBe(input.context)
        await bridge.complete({ id: 'anything' })
        expect(input.createWaitpoint).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
