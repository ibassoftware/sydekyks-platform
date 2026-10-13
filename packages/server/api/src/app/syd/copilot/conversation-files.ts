import { ActivepiecesError, ErrorCode } from '@activepieces/core-utils'
import { CHAT_ALLOWED_MIME_TYPES, FileCompression, FileType } from '@activepieces/shared'
import { UserContent } from 'ai'
import { FastifyBaseLogger } from 'fastify'
import { fileService, GetDataResponse } from '../../file/file.service'

async function extractPdfText(base64Data: string): Promise<string> {
    const pdf = await import('unpdf')
    const document = await pdf.getDocumentProxy(Uint8Array.from(Buffer.from(base64Data, 'base64')))
    const result = await pdf.extractText(document, { mergePages: true })
    return boundedText(result.text)
}

function sanitizeFileName(name: string): string {
    return name.replace(/[^\w .()-]/g, '_').substring(0, 255)
}

async function persistAgentAttachments({ files, projectId, platformId, conversationId, log }: AttachmentSaveParams): Promise<AttachmentReference[]> {
    const storage = fileService(log)
    return Promise.all(files.map(async ({ name, mimeType, data }) => {
        const bytes = Buffer.from(data, 'base64')
        const safeName = sanitizeFileName(name)
        const stored = await storage.save({
            projectId, platformId, data: bytes, size: bytes.byteLength,
            type: FileType.FLOW_STEP_FILE, fileName: safeName, compression: FileCompression.NONE,
            metadata: { conversationId, mimetype: mimeType },
        })
        return { fileId: stored.id, name: safeName, mimeType }
    }))
}

function buildAttachmentNote(refs: AttachmentReference[]): string {
    if (!refs.length) return ''
    return `\n\n[Attachments saved and available to ap_run_code via inputFileIds:\n${refs.map((ref) => `- ${ref.name} → fileId \`${ref.fileId}\` (${ref.mimeType})`).join('\n')}]`
}

async function buildUserContentWithFiles({ text, files = [], attachmentNote }: { text: string, files?: Attachment[], attachmentNote?: string }): Promise<UserContent> {
    if (!files.length) return text
    const sections = await Promise.all(files.map(async (file) => {
        if (file.mimeType === 'application/pdf') return section({ name: file.name, text: await extractPdfText(file.data) })
        if (TEXT_TYPES.has(file.mimeType)) return section({ name: file.name, text: boundedText(Buffer.from(file.data, 'base64').toString('utf8')) })
        return ''
    }))
    const content = text + sections.join('') + (attachmentNote ?? '')
    const images = files.filter((file) => file.mimeType.startsWith('image/'))
    if (!images.length) return content
    const multimodal: UserContent = [{ type: 'text', text: content }]
    for (const image of images) multimodal.push({ type: 'file', mediaType: image.mimeType, data: image.data })
    return multimodal
}

async function readConversationFile({ platformId, conversationId, accessibleProjectIds, fileId, log }: ReadFileParams): Promise<GetDataResponse> {
    const storage = fileService(log)
    const file = await storage.getFileOrThrow({ fileId, type: FileType.FLOW_STEP_FILE })
    if (file.platformId !== platformId || file.metadata?.conversationId !== conversationId || !file.projectId || !accessibleProjectIds.includes(file.projectId)) {
        throw new ActivepiecesError({ code: ErrorCode.ENTITY_NOT_FOUND, params: { entityId: fileId, entityType: 'file' } })
    }
    return storage.getDataOrThrow({ fileId, projectId: file.projectId, type: FileType.FLOW_STEP_FILE })
}

function boundedText(text: string): string {
    return text.length <= 50_000 ? text : `${text.slice(0, 50_000)}\n[Content truncated due to length]`
}
function section({ name, text }: { name: string, text: string }): string {
    return `\n--- File: ${sanitizeFileName(name)} ---\n${text}`
}

const TEXT_TYPES = new Set<string>(CHAT_ALLOWED_MIME_TYPES.filter((type) => type.startsWith('text/') || type === 'application/json'))

export const sydConversationFiles = { extractPdfText, sanitizeFileName, persistAgentAttachments, buildAttachmentNote, buildUserContentWithFiles, readConversationFile }

export type Attachment = { name: string, mimeType: string, data: string }
export type AttachmentReference = { fileId: string, name: string, mimeType: string }
type AttachmentSaveParams = { files: Attachment[], projectId: string, platformId: string, conversationId: string, log: FastifyBaseLogger }
type ReadFileParams = { platformId: string, conversationId: string, accessibleProjectIds: string[], fileId: string, log: FastifyBaseLogger }
