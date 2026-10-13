import { tryCatch } from '@activepieces/core-utils'
import { FastifyBaseLogger } from 'fastify'
import { distributedStore } from '../../database/redis-connections'
import { pubsub } from '../../helper/pubsub'

async function resolveGate({ gateId, approved, payload, log }: ResolveGateParams): Promise<void> {
    const conversationId = await conversationIdForGate({ gateId })
    const gates = conversationId ? await getPendingGates({ conversationId }) : []
    const gate = gates.find((entry) => entry.gateId === gateId)
    const decision: GateDecision = {
        approved, payload,
        approvedInput: gate?.toolInput,
        approvedToolName: gate?.toolName,
        approvedConversationId: conversationId ?? undefined,
        approvedRunId: gate?.runId,
    }
    if (!await distributedStore.putIfAbsent(decisionKey(gateId), decision, GATE_TTL_SECONDS)) {
        return
    }
    await pubsub.publish(channelName(gateId), 'decided')
    if (conversationId) {
        await distributedStore.removeField(pendingKey(conversationId), gateId)
        await distributedStore.delete(gateOwnerKey(gateId))
    }
    log?.info({ gate: { id: gateId }, approved }, 'Syd approval recorded')
}

async function checkDecision({ gateId }: { gateId: string }): Promise<GateDecision | 'pending'> {
    return await distributedStore.get<GateDecision>(decisionKey(gateId)) ?? 'pending'
}

async function consumeApproval({ gateId }: { gateId: string }): Promise<boolean> {
    return distributedStore.putIfAbsent(`${decisionKey(gateId)}:used`, true, GATE_TTL_SECONDS)
}

async function waitForDecision({ gateId, timeoutMs }: { gateId: string, timeoutMs: number }): Promise<GateDecision | 'pending'> {
    return new Promise((resolve, reject) => {
        let complete = false
        const finish = (decision: GateDecision | 'pending'): void => {
            if (complete) return
            complete = true
            clearTimeout(timer)
            void pubsub.unsubscribe(channelName(gateId), listener)
            resolve(decision)
        }
        const check = async (): Promise<void> => {
            const { data, error } = await tryCatch(() => checkDecision({ gateId }))
            if (error) {
                if (!complete) {
                    complete = true
                    clearTimeout(timer)
                    void pubsub.unsubscribe(channelName(gateId), listener)
                    reject(error)
                }
                return
            }
            if (data !== 'pending') finish(data)
        }
        const listener = (): void => {
            void check()
        }
        const timer = setTimeout(() => finish('pending'), timeoutMs)
        void tryCatch(async () => {
            await pubsub.subscribe(channelName(gateId), listener)
            if (complete) {
                await pubsub.unsubscribe(channelName(gateId), listener)
                return
            }
            await check()
        }).then(({ error }) => {
            if (error && !complete) {
                complete = true
                clearTimeout(timer)
                void pubsub.unsubscribe(channelName(gateId), listener)
                reject(error)
            }
        })
    })
}

async function requestCancel(params: CancelIdentifier): Promise<void> {
    await distributedStore.put(cancelKey(params), true, CANCEL_TTL_SECONDS)
}

async function isCancelled(params: CancelIdentifier): Promise<boolean> {
    return await distributedStore.get<boolean>(cancelKey(params)) === true
}

async function clearCancel({ conversationId }: { conversationId: string }): Promise<void> {
    await distributedStore.delete(cancelKey({ conversationId }))
}

async function storeAvailableConnections({ conversationId, pieceName, connections }: { conversationId: string, pieceName: string, connections: StoredConnection[] }): Promise<void> {
    await distributedStore.put(connectionKey({ conversationId, pieceName, selected: false }), connections, CONNECTION_TTL_SECONDS)
}

async function getAvailableConnections({ conversationId, pieceName }: ConnectionIdentifier): Promise<StoredConnection[]> {
    return await distributedStore.get<StoredConnection[]>(connectionKey({ conversationId, pieceName, selected: false })) ?? []
}

async function storeSelectedConnection({ conversationId, pieceName, externalId, label, projectId }: ConnectionIdentifier & SelectedConnection): Promise<void> {
    await distributedStore.put(connectionKey({ conversationId, pieceName, selected: true }), { externalId, label, projectId }, CONNECTION_TTL_SECONDS)
}

async function getSelectedConnection({ conversationId, pieceName }: ConnectionIdentifier): Promise<SelectedConnection | null> {
    return distributedStore.get<SelectedConnection>(connectionKey({ conversationId, pieceName, selected: true }))
}

async function storePendingGate({ conversationId, gate }: { conversationId: string, gate: PendingGate }): Promise<void> {
    await distributedStore.merge(pendingKey(conversationId), { [gate.gateId]: gate }, GATE_TTL_SECONDS)
    await distributedStore.put(gateOwnerKey(gate.gateId), conversationId, GATE_TTL_SECONDS)
}

async function readPendingGates({ conversationId }: { conversationId: string }): Promise<Record<string, PendingGate>> {
    return await distributedStore.hgetJson<Record<string, PendingGate>>(pendingKey(conversationId)) ?? {}
}

async function getPendingGates({ conversationId }: { conversationId: string }): Promise<PendingGate[]> {
    return Object.values(await readPendingGates({ conversationId }))
}

async function conversationIdForGate({ gateId }: { gateId: string }): Promise<string | null> {
    return distributedStore.get<string>(gateOwnerKey(gateId))
}

async function clearPendingGate({ conversationId, runId }: { conversationId: string, runId?: string | null }): Promise<void> {
    const gates = (await getPendingGates({ conversationId })).filter((gate) => runId === undefined || (gate.runId ?? null) === runId)
    for (const gate of gates) await distributedStore.removeField(pendingKey(conversationId), gate.gateId)
    await distributedStore.delete(gates.map((gate) => gateOwnerKey(gate.gateId)))
}

function decisionKey(gateId: string): string {
    return `syd:gate:v1:decision:${gateId}`
}
function channelName(gateId: string): string {
    return `syd:gate:v1:notify:${gateId}`
}
function pendingKey(conversationId: string): string {
    return `syd:gate:v1:pending:${conversationId}`
}
function gateOwnerKey(gateId: string): string {
    return `syd:gate:v1:owner:${gateId}`
}
function cancelKey({ conversationId, runId }: CancelIdentifier): string {
    return `syd:cancel:v1:${conversationId}${runId ? `:${runId}` : ''}`
}
function connectionKey({ conversationId, pieceName, selected }: ConnectionIdentifier & { selected: boolean }): string {
    return `syd:connection:v1:${selected ? 'selected' : 'available'}:${conversationId}:${pieceName}`
}

const GATE_TTL_SECONDS = 900
const CANCEL_TTL_SECONDS = 7200
const CONNECTION_TTL_SECONDS = 86400

export const sydApprovalGate = {
    resolveGate, checkDecision, consumeApproval, waitForDecision,
    requestCancel, isCancelled, clearCancel,
    storeAvailableConnections, getAvailableConnections, storeSelectedConnection, getSelectedConnection,
    storePendingGate, readPendingGates, getPendingGates, conversationIdForGate, clearPendingGate,
}

export type GateDecision = {
    approved: boolean
    payload?: Record<string, unknown>
    approvedInput?: Record<string, unknown>
    approvedToolName?: string
    approvedConversationId?: string
    approvedRunId?: string
}
export type PendingGate = { gateId: string, toolName: string, displayName: string, toolInput: Record<string, unknown>, runId?: string }
export type StoredConnection = { externalId: string, label: string, projectId: string, project: string, status: string, grantedScopes: string[] }
export type SelectedConnection = Pick<StoredConnection, 'externalId' | 'label' | 'projectId'>
type ResolveGateParams = { gateId: string, approved: boolean, payload?: Record<string, unknown>, log?: FastifyBaseLogger }
type CancelIdentifier = { conversationId: string, runId?: string }
type ConnectionIdentifier = { conversationId: string, pieceName: string }
