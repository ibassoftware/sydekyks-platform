import { createHash } from 'node:crypto'
import { ActionContext, CreateWaitpointHook, InputPropertyMap, PieceAuthProperty } from '@activepieces/pieces-framework'
import { ExecutionType } from '@activepieces/shared'
import { retryFetch } from '../api/retry-fetch'
import { throwForRejectedRequest } from './rejected-request'

type TodoContext = ActionContext<PieceAuthProperty, InputPropertyMap>

/**
 * The catalogue Todo package predates durable waitpoints. In particular, its
 * wait-existing action never tells the server which task it is waiting for.
 * Bridge only those known actions, leaving the package's result/resume shapes
 * intact. The API binds task/run/waitpoint authority; no supplied URL is fetched.
 */
export async function prepareLegacyTodo({ context, pieceName, actionName, waitpointKey, isSingleStepTest, createTodoWaitpoint }: {
    context: TodoContext
    pieceName: string
    actionName: string
    waitpointKey: string
    isSingleStepTest: boolean
    createTodoWaitpoint: CreateWaitpointHook
}): Promise<{ context: TodoContext, complete: (output: unknown) => Promise<void> }> {
    const unchanged = { context, complete: async (_output: unknown): Promise<void> => undefined }
    if (pieceName !== '@activepieces/piece-todos' || !['createTodo', 'createTodoAndWait', 'wait_for_approval'].includes(actionName) || context.executionType !== ExecutionType.BEGIN) {
        return unchanged
    }

    if (actionName === 'createTodo') {
        // A retried HTTP response must identify the same task, while another
        // step/loop iteration or explicit full-run retry gets its own task.
        const key = createHash('sha256').update(waitpointKey).digest('hex')
        return {
            ...unchanged,
            context: {
                ...context,
                generateResumeUrl: ({ queryParams }) => {
                    const url = new URL(`${context.server.publicUrl}v1/flow-runs/${context.run.id}/requests/todo-${key}`)
                    url.search = new URLSearchParams(queryParams).toString()
                    return url.toString()
                },
            },
        }
    }

    // The legacy test for waiting on an existing task is a read-only preview.
    if (actionName === 'wait_for_approval' && isSingleStepTest) {
        return unchanged
    }

    // Await creation before executing the old fire-and-forget pause hook. This
    // also fails before creating a Todo when action-run mode cannot suspend.
    const waitpoint = await createTodoWaitpoint({ type: 'WEBHOOK', version: 'V1', responseToSend: {} })
    return {
        context: {
            ...context,
            generateResumeUrl: waitpoint.buildResumeUrl,
            run: {
                ...context.run,
                pause: () => context.run.waitForWaitpoint(waitpoint.id),
            },
        },
        complete: async (output) => {
            const taskId = actionName === 'wait_for_approval'
                ? context.propsValue.taskId
                : (output && typeof output === 'object' && 'id' in output ? output.id : undefined)
            if (typeof taskId !== 'string' || taskId.length === 0) {
                throw new Error('The Todo action did not return a task ID.')
            }
            const response = await retryFetch(`${context.server.apiUrl}v1/todos/${encodeURIComponent(taskId)}/wait`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${context.server.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ flowRunId: context.run.id, waitpointId: waitpoint.id }),
            })
            if (!response.ok) {
                await throwForRejectedRequest({ response, name: 'TodoWaitRegistrationError', summary: 'Failed to bind the Todo waitpoint' })
            }
        },
    }
}
