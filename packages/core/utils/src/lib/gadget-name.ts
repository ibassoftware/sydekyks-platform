// Public Gadget aliases never change persisted package identities or registry lookups.
const INTERNAL_PREFIX = '@activepieces/piece-'
const PUBLIC_PREFIX = '@sydekyks/piece-'

export function internalGadgetName(name: string): string {
    return name.startsWith(PUBLIC_PREFIX) ? INTERNAL_PREFIX + name.slice(PUBLIC_PREFIX.length) : name
}

export function publicGadgetName(name: string): string {
    return name.startsWith(INTERNAL_PREFIX) ? PUBLIC_PREFIX + name.slice(INTERNAL_PREFIX.length) : name
}

export function publicGadgetText(text: string): string {
    return text.replace(/@activepieces\/piece-/g, PUBLIC_PREFIX)
}
