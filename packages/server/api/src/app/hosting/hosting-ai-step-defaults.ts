import { AIProviderName } from '@activepieces/core-utils'
import { PieceMetadataModel, PropertyType } from '@activepieces/pieces-framework'

// Metadata defaults seed new steps; they do not rewrite saved inputs or replace
// a selected BYOK key. Keep unsupported image/Agent actions and self-hosted
// metadata untouched. Clone rather than modifying the shared catalogue cache.
const ACTIONS = new Set(['askAi', 'summarizeText', 'classifyText', 'extractStructuredData'])

export function hostedAiStepDefaults(piece: PieceMetadataModel, hosted: boolean): PieceMetadataModel {
    if (!hosted || piece.name !== '@activepieces/piece-ai') return piece
    return { ...piece, actions: Object.fromEntries(Object.entries(piece.actions).map(([name, action]) => {
        if (!ACTIONS.has(name) || action.props.provider?.type !== PropertyType.DROPDOWN || action.props.model?.type !== PropertyType.DROPDOWN) return [name, action]
        return [name, { ...action, props: { ...action.props,
            provider: { ...action.props.provider, defaultValue: { provider: AIProviderName.ACTIVEPIECES } },
            model: { ...action.props.model, defaultValue: 'sydekyks' },
        } }]
    })) }
}
