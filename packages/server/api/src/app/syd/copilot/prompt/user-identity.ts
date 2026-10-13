import { PersonalizationIdentity } from '../personalization/personalization-view'

function fullName({ firstName, lastName }: { firstName: string, lastName: string }): string {
    return `${firstName.trim()} ${lastName.trim()}`.trim()
}

function companyHintFromEmail({ email }: { email: string }): { domain: string, company: string } | null {
    const domain = email.substring(email.lastIndexOf('@') + 1).trim().toLowerCase()
    if (!email.includes('@') || !domain || PERSONAL_EMAIL_DOMAINS.has(domain)) return null
    const label = domain.split('.')[0]
    return label ? { domain, company: label[0].toUpperCase() + label.substring(1) } : null
}

function buildUserIdentityNote({ firstName, lastName, email, platformName, identity }: UserIdentity): string {
    const company = identity?.company
    const hint = companyHintFromEmail({ email })
    return [
        `\n\n${HEADING}`,
        `You are helping ${fullName({ firstName, lastName }) || 'the person'} at ${email}. Use their first name naturally; this is the address meant by "email me".`,
        company ? `Researched company: ${company.name}. ${company.description}. Industry: ${company.industry}. Ground suggestions in this context.` : hint ? `Email domain ${hint.domain} suggests ${hint.company}. Verify this hint before treating it as a fact.` : '',
        identity?.role ? `Their own stated role is ${identity.role}. Tailor examples to it; do not attribute it to their teammates.` : '',
        platformName ? `The product is branded ${platformName}. Use this configured name in user-facing answers.` : '',
    ].filter(Boolean).join('\n')
}

const HEADING = '## Who you\'re talking to'
const PERSONAL_EMAIL_DOMAINS = new Set('gmail.com googlemail.com outlook.com hotmail.com hotmail.co.uk live.com msn.com yahoo.com yahoo.co.uk ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.net mail.com zoho.com yandex.com yandex.ru fastmail.com hey.com tutanota.com qq.com 163.com 126.com'.split(' '))

export const sydUserIdentity = { fullName, companyHintFromEmail, buildUserIdentityNote, buildNote: buildUserIdentityNote, heading: HEADING }

export type UserIdentity = { firstName: string, lastName: string, email: string, platformName: string | null, identity: PersonalizationIdentity | null }
