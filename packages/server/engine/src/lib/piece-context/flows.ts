import { SeekPage } from '@activepieces/core-utils'
import { FlowsContext, ListFlowsContextParams, PopulatedFlowSummary } from '@activepieces/pieces-framework'
import { FetchError, PopulatedFlow } from '@activepieces/shared'
import { retryFetch } from '../api/retry-fetch'

export const createFlowsContext = ({ engineToken, internalApiUrl, flowId, flowVersionId }: CreateFlowsServiceParams): FlowsContext => {
    return {
        async list(params: ListFlowsContextParams = {}): Promise<SeekPage<PopulatedFlowSummary>> {
            const queryParams = new URLSearchParams()
            if (params?.externalIds) {
                queryParams.set('externalIds', params.externalIds.join(','))
            }
            const url = `${internalApiUrl}v1/engine/populated-flows?${queryParams.toString()}`
            const response = await retryFetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${engineToken}`,
                },
            })
            if (!response.ok) {
                throw new FetchError(url, `status=${response.status}`)
            }
            const page: SeekPage<PopulatedFlow> = await response.json()
            return {
                ...page,
                data: page.data.map(flow => ({ ...flow, displayName: flow.version.displayName })),
            }
        },
        current: {
            id: flowId,
            version: {
                id: flowVersionId,
            },
        },
    }
}

type CreateFlowsServiceParams = {
    engineToken: string
    internalApiUrl: string
    flowId: string
    flowVersionId: string
}
