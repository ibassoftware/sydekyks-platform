/** A local first-message label. No model call and no additional Credits. */
export function conversationTitle(content: string): string | null {
    const text = content.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!text) return null
    const characters = Array.from(text)
    return characters.length <= 72 ? text : characters.slice(0, 71).join('').trimEnd() + '…'
}
