import { PieceMetadataModel } from '@activepieces/pieces-framework'
import { FastifyBaseLogger } from 'fastify'

async function resolveVisibility(_params: { platformId: string | undefined, projectId?: string, log: FastifyBaseLogger }) {
    return {
        isPieceVisible: (_name: string) => true,
        filterPieceComponents: (piece: PieceMetadataModel) => piece,
        filterPieces: <T>(pieces: T[]) => pieces,
        filterComponents: <T>(pieces: T[]) => pieces,
    }
}

export { resolveVisibility }
