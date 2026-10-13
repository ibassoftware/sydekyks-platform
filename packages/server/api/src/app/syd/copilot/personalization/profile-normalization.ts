function normalizeRoleTitle({ input }: { input: string }): string | null {
    const words = input.trim().split(/\s+/).filter(Boolean)
    if (!words.length) return null
    return words.map((word, position) => {
        const lower = word.toLowerCase()
        if (ACRONYMS.has(lower)) return lower.toUpperCase()
        if (position && CONNECTORS.has(lower)) return lower
        return word.slice(0, 1).toUpperCase() + word.slice(1)
    }).join(' ')
}

function normalizeWebsite({ input }: { input: string }): string | null {
    const host = input.trim().toLowerCase().replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\//, '').split(/[/?#:]/)[0].replace(/\.$/, '').replace(/^(?:www|mail)\./, '')
    const labels = host.split('.')
    if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || ['localhost', 'local'].includes(labels.at(-1) ?? '')) return null
    return host
}

const ACRONYMS = new Set('ceo cto coo cfo cmo cpo cro ciso cio chro vp svp evp hr it qa pr seo sem ux ui ai ml bi l&d r&d gm pm gtm sdr bdr ae sre csm crm saas api'.split(' '))
const CONNECTORS = new Set('of and the for in at to a an &'.split(' '))

export const sydProfileNormalization = { normalizeRoleTitle, normalizeWebsite }
