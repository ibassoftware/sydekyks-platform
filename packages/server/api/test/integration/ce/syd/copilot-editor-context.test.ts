import { FlowVersionState } from '@activepieces/shared'
import Fastify from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../../../../src/app/database'
import { databaseConnection } from '../../../../src/app/database/database-connection'
import { sydEditorContext } from '../../../../src/app/syd/copilot/editor-context'
import { createMockFlow, createMockFlowVersion, mockAndSaveBasicSetup } from '../../../helpers/mocks'

const log = Fastify().log

beforeAll(async () => initializeDatabase({ runMigrations: false }))
afterAll(async () => databaseConnection().destroy())

async function editorFixture() {
    const setup = await mockAndSaveBasicSetup()
    const flow = createMockFlow({ projectId: setup.mockProject.id })
    const version = createMockFlowVersion({ flowId: flow.id, state: FlowVersionState.DRAFT, displayName: 'Editor workflow' })
    await databaseConnection().getRepository('flow').save(flow)
    await databaseConnection().getRepository('flow_version').save(version)
    return { flow, version, actor: { platformId: setup.mockPlatform.id, userId: setup.mockOwner.id } }
}

describe('Syd mission editor context', () => {
    it('resolves the viewed workflow and selected step for its owner', async () => {
        const { actor, flow, version } = await editorFixture()
        const result = await sydEditorContext.getForUser({ ...actor, context: { flowId: flow.id, flowVersionId: version.id, selectedStepName: 'trigger' }, log })
        expect(result.projectId).toBe(flow.projectId)
        expect(result.note).toContain(flow.id)
        expect(result.note).toContain('"selectedStepName":"trigger"')
    })

    it('rejects editor context belonging to another platform and user', async () => {
        const owner = await editorFixture()
        const stranger = await editorFixture()
        await expect(sydEditorContext.getForUser({ ...stranger.actor, context: { flowId: owner.flow.id, flowVersionId: owner.version.id }, log })).rejects.toThrow()
    })

    it('rejects a version belonging to a different workflow', async () => {
        const owner = await editorFixture()
        const otherFlow = createMockFlow({ projectId: owner.flow.projectId })
        const otherVersion = createMockFlowVersion({ flowId: otherFlow.id, state: FlowVersionState.DRAFT })
        await databaseConnection().getRepository('flow').save(otherFlow)
        await databaseConnection().getRepository('flow_version').save(otherVersion)
        await expect(sydEditorContext.getForUser({ ...owner.actor, context: { flowId: owner.flow.id, flowVersionId: otherVersion.id }, log })).rejects.toThrow()
    })
})
