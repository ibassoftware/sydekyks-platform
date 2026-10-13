import { FastifyBaseLogger } from 'fastify'
import { AddConversationCreditsParams, AiUsageHooks } from '../../ai/ai-usage-hooks'
import { databaseConnection } from '../../database/database-connection'
import { SydConversationEntity } from './models/conversation.entity'

export const sydConversationUsage = (_log: FastifyBaseLogger): AiUsageHooks => ({
    async addConversationCredits({ conversationId, credits }: AddConversationCreditsParams): Promise<void> {
        const delta = Math.round(credits)
        if (!Number.isFinite(delta)) throw new Error('Invalid conversation credit amount')
        if (delta === 0) return
        await databaseConnection().getRepository(SydConversationEntity).createQueryBuilder().update()
            .set({ aiCredits: () => 'COALESCE("aiCredits", 0) + :delta' })
            .where({ id: conversationId }).setParameter('delta', delta).execute()
    },
})
