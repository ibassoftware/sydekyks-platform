import { apId } from '@activepieces/core-utils'
import { afterAll, describe, expect, it } from 'vitest'
import { redisConnections } from '../../../../src/app/database/redis-connections'
import { pubsub } from '../../../../src/app/helper/pubsub'
import { sydApprovalGate } from '../../../../src/app/syd/copilot/approval-gate'
import { sydCopilotContext } from '../../../../src/app/syd/copilot/copilot-context'
import { sydRunOperations } from '../../../../src/app/syd/copilot/rpc/run-operations'
import { sydToolApproval } from '../../../../src/app/syd/copilot/rpc/tool-execution-rpc'

describe.skipIf(process.env.SYD_TEST_REDIS !== 'true')('Syd Redis approvals and cancellation', () => {
    afterAll(async () => { await pubsub.close(); await redisConnections.destroy() })

    it('binds the winning decision to its exact preview and notifies a waiting consumer', async () => {
        const conversationId = apId()
        const gateId = apId()
        const runId = apId()
        const toolInput = { agentId: 'agent', instructions: 'Sort the inbox' }
        await sydApprovalGate.storePendingGate({ conversationId, gate: { gateId, runId, toolName: 'ap_update_agent', displayName: 'Update agent', toolInput } })
        const waiting = sydApprovalGate.waitForDecision({ gateId, timeoutMs: 2000 })
        await sydApprovalGate.resolveGate({ gateId, approved: true, payload: { selected: 'yes' } })
        expect(await waiting).toMatchObject({ approved: true, approvedInput: toolInput, approvedToolName: 'ap_update_agent', approvedRunId: runId, approvedConversationId: conversationId, payload: { selected: 'yes' } })
        expect(await sydApprovalGate.getPendingGates({ conversationId })).toEqual([])
        expect(await sydApprovalGate.conversationIdForGate({ gateId })).toBeNull()
        await sydApprovalGate.resolveGate({ gateId, approved: false })
        expect(await sydApprovalGate.checkDecision({ gateId })).toMatchObject({ approved: true })
    })

    it('finds a decision published before the consumer subscribes', async () => {
        const gateId = apId()
        await sydApprovalGate.resolveGate({ gateId, approved: false })
        expect(await sydApprovalGate.waitForDecision({ gateId, timeoutMs: 100 })).toMatchObject({ approved: false })
        expect(await sydApprovalGate.waitForDecision({ gateId: apId(), timeoutMs: 10 })).toBe('pending')
    })

    it('permits only one competing resolver and one approval consumption', async () => {
        const gateId = apId()
        const conversationId = apId()
        await sydApprovalGate.storePendingGate({ conversationId, gate: { gateId, toolName: 'ap_send_email', displayName: 'Email', toolInput: { to: ['person@example.com'], subject: 'Approved', body: 'Exact text' } } })
        await Promise.all([sydApprovalGate.resolveGate({ gateId, approved: true }), sydApprovalGate.resolveGate({ gateId, approved: false })])
        expect(await sydApprovalGate.checkDecision({ gateId })).not.toBe('pending')
        const consumed = await Promise.all([sydApprovalGate.consumeApproval({ gateId }), sydApprovalGate.consumeApproval({ gateId })])
        expect(consumed.filter(Boolean)).toHaveLength(1)
    })

    it('rejects changed content, changed scope and replayed agent-edit approvals', async () => {
        const gateId = apId()
        const conversationId = apId()
        const runId = apId()
        const toolInput = { agentId: 'agent', instructions: 'Reviewed' }
        await sydApprovalGate.storePendingGate({ conversationId, gate: { gateId, runId, toolName: 'ap_update_agent', displayName: 'Agent', toolInput } })
        await sydApprovalGate.resolveGate({ gateId, approved: true })
        const request = { conversationId, runId, toolName: 'ap_update_agent', toolInput: { ...toolInput, approvedGateId: gateId } }
        expect(await sydToolApproval.approvedByHuman({ ...request, toolInput: { ...request.toolInput, instructions: 'Different' } })).toBe(false)
        expect(await sydToolApproval.approvedByHuman({ ...request, conversationId: apId() })).toBe(false)
        expect(await sydToolApproval.approvedByHuman({ ...request, runId: apId() })).toBe(false)
        expect(await sydToolApproval.approvedByHuman(request)).toBe(true)
        expect(await sydToolApproval.approvedByHuman(request)).toBe(false)
    })

    it('clears a preempted run gate without deleting the new run gate', async () => {
        const conversationId = apId()
        const first = { gateId: apId(), runId: 'old', toolName: 'ap_show_questions', displayName: 'Questions', toolInput: {} }
        const second = { ...first, gateId: apId(), runId: 'new' }
        await sydApprovalGate.storePendingGate({ conversationId, gate: first })
        await sydApprovalGate.storePendingGate({ conversationId, gate: second })
        await sydApprovalGate.clearPendingGate({ conversationId, runId: 'old' })
        expect(await sydApprovalGate.getPendingGates({ conversationId })).toEqual([second])
        expect(await sydApprovalGate.conversationIdForGate({ gateId: first.gateId })).toBeNull()
        expect(await sydApprovalGate.conversationIdForGate({ gateId: second.gateId })).toBe(conversationId)
    })

    it('keeps cancellation markers separated by run and conversation', async () => {
        const conversationId = apId()
        await sydApprovalGate.requestCancel({ conversationId, runId: 'old' })
        expect(await sydApprovalGate.isCancelled({ conversationId, runId: 'old' })).toBe(true)
        expect(await sydApprovalGate.isCancelled({ conversationId, runId: 'new' })).toBe(false)
        expect(await sydApprovalGate.isCancelled({ conversationId })).toBe(false)
        await sydApprovalGate.requestCancel({ conversationId })
        await sydApprovalGate.clearCancel({ conversationId })
        expect(await sydApprovalGate.isCancelled({ conversationId })).toBe(false)
        expect(await sydApprovalGate.isCancelled({ conversationId, runId: 'old' })).toBe(true)
    })

    it('separates available and selected connection accounts for each piece', async () => {
        const conversationId = apId()
        const connection = { externalId: 'account', label: 'Inbox', projectId: 'project', project: 'Team', status: 'ACTIVE', grantedScopes: ['read'] }
        await sydApprovalGate.storeAvailableConnections({ conversationId, pieceName: 'mail', connections: [connection] })
        await sydApprovalGate.storeSelectedConnection({ conversationId, pieceName: 'mail', externalId: connection.externalId, label: connection.label, projectId: connection.projectId })
        expect(await sydApprovalGate.getAvailableConnections({ conversationId, pieceName: 'mail' })).toEqual([connection])
        expect(await sydApprovalGate.getSelectedConnection({ conversationId, pieceName: 'mail' })).toEqual({ externalId: 'account', label: 'Inbox', projectId: 'project' })
        expect(await sydApprovalGate.getSelectedConnection({ conversationId, pieceName: 'other' })).toBeNull()
    })

    it('bounds fixed-window counters atomically and records turn-read state', async () => {
        const key = apId()
        const counts = await Promise.all(Array.from({ length: 12 }, () => sydCopilotContext.incrementAndCheckLimit({ key, limit: 5, ttlSeconds: 600 })))
        expect(counts.filter((count) => count.allowed)).toHaveLength(5)
        expect(Math.max(...counts.map((count) => count.count))).toBe(12)
        expect(await (await redisConnections.useExisting()).ttl(key)).toBeGreaterThan(0)
        const scope = { conversationId: apId(), runId: apId() }
        expect(await sydRunOperations.turnHasRead(scope)).toBe(false)
        await sydRunOperations.markTurnAsHavingRead(scope)
        expect(await sydRunOperations.turnHasRead(scope)).toBe(true)
        expect(await sydRunOperations.turnHasRead({ conversationId: scope.conversationId })).toBe(true)
    })
})
