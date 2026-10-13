import { UserIdentity } from '@activepieces/shared'
import { FastifyBaseLogger } from 'fastify'
import nodemailer from 'nodemailer'
import { system } from '../helper/system/system'
import { AppSystemProp } from '../helper/system/system-props'

function isSmtpConfigured(): boolean {
    return [AppSystemProp.SMTP_HOST, AppSystemProp.SMTP_PORT, AppSystemProp.SMTP_USERNAME, AppSystemProp.SMTP_PASSWORD, AppSystemProp.SMTP_SENDER_EMAIL].every(key => Boolean(system.get(key)))
}

async function send({ to, subject, text }: { to: string, subject: string, text: string }): Promise<void> {
    if (!isSmtpConfigured()) throw new Error('Configure SMTP to send account emails')
    const port = Number(system.getOrThrow(AppSystemProp.SMTP_PORT))
    const transport = nodemailer.createTransport({ host: system.getOrThrow(AppSystemProp.SMTP_HOST), port, secure: port === 465, requireTLS: port !== 465, auth: { user: system.getOrThrow(AppSystemProp.SMTP_USERNAME), pass: system.getOrThrow(AppSystemProp.SMTP_PASSWORD) }, tls: { rejectUnauthorized: true } })
    try {
        await transport.sendMail({ from: { name: 'Sydekyks', address: system.getOrThrow(AppSystemProp.SMTP_SENDER_EMAIL) }, to, subject, text }) 
    }
    finally {
        transport.close() 
    }
}

export const smtpEmailSender = (_log: FastifyBaseLogger) => ({ isSmtpConfigured })
export const emailService = (_log: FastifyBaseLogger) => ({
    async sendOtp({ userIdentity, otp }: { platformId?: string | null, userIdentity: UserIdentity, otp: string, type: string }): Promise<void> {
        await send({ to: userIdentity.email, subject: 'Your Sydekyks verification code', text: `Your verification code is ${otp}. If you did not request this, you can ignore this email.` }) 
    },
    async sendInvitation({ userInvitation, invitationLink }: { userInvitation: { email: string }, invitationLink: string }): Promise<void> {
        await send({ to: userInvitation.email, subject: 'Your Sydekyks invitation', text: `You have been invited to Sydekyks. Review the invitation here: ${invitationLink}` }) 
    },
    async sendProjectMemberAdded(_params: unknown): Promise<never> {
        throw new Error('Project membership invitations are unsupported') 
    },
})
