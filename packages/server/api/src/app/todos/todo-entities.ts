import { EntitySchema } from 'typeorm'
import { ApIdSchema, BaseColumnSchemaPart } from '../database/database-common'

export type TodoOption = { name: string, description?: string, variant: string, continueFlow: boolean }
export type CatalogueTodo = { id: string, created: string, updated: string, projectId: string, platformId: string, flowId: string, runId: string | null, title: string, description: string, statusOptions: TodoOption[], status: TodoOption | null, assigneeId: string | null, message: string | null, resolvedBy: string | null, resolvedAt: Date | null, requestKey: string, requestHash: string }
export type CatalogueTodoWaiter = { id: string, created: string, updated: string, todoId: string, projectId: string, flowRunId: string, waitpointId: string, deliveredAt: Date | null }
export const CatalogueTodoEntity = new EntitySchema<CatalogueTodo>({
    name: 'catalogue_todo', columns: {
        ...BaseColumnSchemaPart, projectId: ApIdSchema, platformId: ApIdSchema, flowId: ApIdSchema, runId: { ...ApIdSchema, nullable: true },
        title: { type: String, length: 200 }, description: { type: String, length: 20000 }, statusOptions: { type: 'jsonb' }, status: { type: 'jsonb', nullable: true }, assigneeId: { ...ApIdSchema, nullable: true }, message: { type: String, length: 4000, nullable: true }, resolvedBy: { ...ApIdSchema, nullable: true }, resolvedAt: { type: 'timestamp with time zone', nullable: true }, requestKey: { type: String, length: 160 }, requestHash: { type: String, length: 64 },
    }, uniques: [{ columns: ['projectId', 'requestKey'] }], indices: [{ columns: ['projectId', 'created'] }], foreignKeys: [{ target: 'project', columnNames: ['projectId'], referencedColumnNames: ['id'], onDelete: 'CASCADE' }],
})
export const CatalogueTodoWaiterEntity = new EntitySchema<CatalogueTodoWaiter>({
    name: 'catalogue_todo_waiter', columns: { ...BaseColumnSchemaPart, todoId: ApIdSchema, projectId: ApIdSchema, flowRunId: ApIdSchema, waitpointId: ApIdSchema, deliveredAt: { type: 'timestamp with time zone', nullable: true } }, uniques: [{ columns: ['waitpointId'] }], indices: [{ columns: ['flowRunId'] }], foreignKeys: [{ target: 'catalogue_todo', columnNames: ['todoId'], referencedColumnNames: ['id'], onDelete: 'CASCADE' }],
})
export const CATALOGUE_TODO_ENTITIES = [CatalogueTodoEntity, CatalogueTodoWaiterEntity]
