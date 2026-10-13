import { tryCatch } from '@activepieces/core-utils'
import { AgentConversationStatus, SendAgentEmailRequest, SendAgentEmailResponse } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import nodemailer from 'nodemailer'
import { system } from '../../../helper/system/system'
import { AppSystemProp } from '../../../helper/system/system-props'
import { platformService } from '../../../platform/platform.service'
import { userService } from '../../../user/user-service'
import { sydApprovalGate } from '../approval-gate'
import { sydConversationService } from '../conversation-service'
import { sydCopilotContext } from '../copilot-context'

function isSmtpConfigured(): boolean {
    return [AppSystemProp.SMTP_HOST, AppSystemProp.SMTP_PORT, AppSystemProp.SMTP_USERNAME, AppSystemProp.SMTP_PASSWORD].every((property) => system.get(property) !== undefined && system.get(property) !== null)
}

function isLikelyEmailAddress(email: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}
function normalizeRecipients(recipients: string[]): string[] {
    return [...new Set(recipients.map((email) => email.trim().toLowerCase()).filter(Boolean))]
}

function emailApprovalMatches({ approvedInput, recipients, subject, body }: { approvedInput?: Record<string, unknown>, recipients: string[], subject: string, body: string }): boolean {
    if (!approvedInput || !Array.isArray(approvedInput.to)) return false
    const approved = normalizeRecipients(approvedInput.to.filter((address): address is string => typeof address === 'string'))
    return approved.length === recipients.length && recipients.every((address) => approved.includes(address)) && approvedInput.subject === subject && approvedInput.body === body
}

async function sendNotification({ platformId, recipients, subject, body, senderName, senderEmail, log }: NotificationParams): Promise<void> {
    const platform = await platformService(log).getOneOrThrow(platformId)
    const port = Number(system.getOrThrow(AppSystemProp.SMTP_PORT))
    const client = nodemailer.createTransport({ host: system.getOrThrow(AppSystemProp.SMTP_HOST), port, secure: port === 465,
        auth: { user: system.getOrThrow(AppSystemProp.SMTP_USERNAME), pass: system.getOrThrow(AppSystemProp.SMTP_PASSWORD) },
        tls: { rejectUnauthorized: system.getBoolean(AppSystemProp.SMTP_TLS_REJECT_UNAUTHORIZED) ?? true },
    })
    await client.sendMail({
        from: { name: system.get(AppSystemProp.SMTP_SENDER_NAME) || platform.name, address: system.getOrThrow(AppSystemProp.SMTP_SENDER_EMAIL) },
        replyTo: { name: senderName, address: senderEmail }, to: recipients, subject, text: body,
        html: `<html><body style="margin:0;font-family:Arial,sans-serif;color:#0a0a0a"><table role="presentation" style="max-width:560px;text-align:left"><tr><td><p>${escapeHtml(platform.name)}</p><p style="white-space:pre-wrap">${escapeHtml(body)}</p><p>Sent on behalf of ${escapeHtml(senderName)}</p></td></tr></table></body></html>`,
    })
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export const sydEmailRpc = (log: FastifyBaseLogger) => ({
    isSmtpConfigured,
    async sendAgentEmail(input: SendAgentEmailRequest): Promise<SendAgentEmailResponse> {
        if (!isSmtpConfigured()) return { sent: false, message: 'Email is not configured on this instance.' }
        const { conversationId, platformId, userId, subject, body } = input
        const conversation = await sydConversationService(log).getConversationOrThrow({ id: conversationId, platformId, userId })
        if (input.runId && (conversation.status !== AgentConversationStatus.STREAMING || (conversation.activeRunId && conversation.activeRunId !== input.runId))) return { sent: false, message: 'This turn is no longer active, so the email was not sent.' }
        const recipients = normalizeRecipients(input.to)
        if (!recipients.length) return { sent: false, message: 'No valid recipient email address was provided.' }
        if (recipients.length > 10) return { sent: false, message: 'You can send to at most 10 recipients at once.' }
        const invalid = recipients.filter((recipient) => !isLikelyEmailAddress(recipient))
        if (invalid.length) return { sent: false, message: `These are not valid email addresses: ${invalid.join(', ')}.`, blockedRecipients: invalid }
        if (!subject.trim()) return { sent: false, message: 'The email subject cannot be empty.' }
        if (subject.length > 300 || body.length > 10_000) return { sent: false, message: 'The email subject or body is too long.' }
        const sender = await userService(log).getMetaInformation({ id: userId })
        const external = recipients.filter((recipient) => recipient !== sender.email.toLowerCase().trim())
        if (external.length) {
            const approval = input.gateId ? await sydApprovalGate.checkDecision({ gateId: input.gateId }) : 'pending'
            if (approval === 'pending' || !approval.approved || !emailApprovalMatches({ approvedInput: approval.approvedInput, recipients, subject, body })) return { sent: false, message: 'Sending to anyone other than your own address needs your explicit approval first.', blockedRecipients: external }
        }
        const limits = await Promise.all([
            sydCopilotContext.incrementAndCheckLimit({ key: `syd:email:conversation:v1:${platformId}:${conversationId}`, limit: 20, ttlSeconds: 86_400 }),
            sydCopilotContext.incrementAndCheckLimit({ key: `syd:email:user:v1:${platformId}:${userId}`, limit: 30, ttlSeconds: 3600 }),
        ])
        if (limits.some((limit) => !limit.allowed)) return { sent: false, message: 'You have reached the email sending limit for now. Please try again later.' }
        const sent = await tryCatch(() => sendNotification({ platformId, recipients, subject, body, senderName: `${sender.firstName} ${sender.lastName}`.trim() || sender.email, senderEmail: sender.email, log }))
        if (sent.error) {
            log.error({ error: sent.error, conversation: { id: conversationId } }, 'Syd email delivery failed'); return { sent: false, message: 'The email could not be sent due to a server error.' }
        }
        return { sent: true, message: `Email sent to ${recipients.join(', ')}.` }
    },
})

type NotificationParams = { platformId: string, recipients: string[], subject: string, body: string, senderName: string, senderEmail: string, log: FastifyBaseLogger }
