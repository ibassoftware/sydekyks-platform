import { FileType, FlowRunStatus, UploadRunLogsRequest } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import { z } from 'zod'
import { fileService } from '../file/file.service'
import { hostingServices } from './hosting-services'
import { hostingFail } from './hosting-transactions'

export async function hostedRunCallback({ log, admissionId, connectionId, projectId, request }: { log: FastifyBaseLogger, admissionId?: string, connectionId?: string, projectId: string, request: UploadRunLogsRequest }) {
    let checkpoint: Record<string, unknown> | undefined
    if (request.status === FlowRunStatus.PAUSED) {
        if (!request.logsFileId) hostingFail('HOSTING_CHECKPOINT_REQUIRED')
        const file = await fileService(log).getDataOrThrow({ projectId, fileId: request.logsFileId, type: FileType.FLOW_RUN_LOG })
        if (file.data.length > 1024 * 1024) hostingFail('HOSTING_CHECKPOINT_LIMIT')
        checkpoint = z.object({ executionState: z.object({ steps: z.record(z.string(), z.unknown()) }).passthrough() }).passthrough().parse(JSON.parse(file.data.toString('utf8')))
    }
    await hostingServices.execution().flowReceipt({ admissionId, connectionId, projectId, runId: request.runId, status: request.status, checkpoint, logsFileId: request.logsFileId, waitpointId: request.waitpointId })
}
