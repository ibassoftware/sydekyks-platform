import { ChatPersonalization, ChatPersonalizationProgressEvent, ChatPersonalizationScope, ChatPersonalizationStatus, ChatPersonalizationView, PersonalizationPrefill, PersonalizationScope, WebsocketClientEvent } from '@activepieces/shared'
import { websocketService } from '../../../core/websockets.service'

function toView({ row, scope, inputsRow, role, personalStatus, prefill }: ViewParams): ChatPersonalizationView {
    const { status, useCases, profile } = row
    return { status, personalStatus, scope, useCases: useCases ?? [], profile: profile ?? null,
        companyInput: inputsRow.companyText ?? inputsRow.domain ?? null, roleInput: role, prefill }
}

function toScopeEnum(scope: PersonalizationScope): ChatPersonalizationScope {
    return scope === 'user' ? ChatPersonalizationScope.USER : ChatPersonalizationScope.COMPANY
}

function emitProgress({ userId, event }: { userId: string, event: ChatPersonalizationProgressEvent }): void {
    websocketService.to(userId).emit(WebsocketClientEvent.CHAT_PERSONALIZATION_PROGRESS, event)
}

export const sydPersonalizationView = { toView, toScopeEnum, emitProgress }

export type PersonalizationIdentityCompany = { name: string, description: string, industry: string }
export type PersonalizationIdentity = { company: PersonalizationIdentityCompany | null, role: string | null }
type ViewParams = { row: ChatPersonalization, scope: ChatPersonalizationScope, inputsRow: ChatPersonalization, role: string | null, personalStatus: ChatPersonalizationStatus, prefill: PersonalizationPrefill | null }
