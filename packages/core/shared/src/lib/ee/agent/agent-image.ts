import { z } from 'zod'

export const MAX_AGENT_IMAGE_BYTES = 48 * 1024
const MAX_AGENT_IMAGE_DIMENSION = 1024

// Raster data travels with the authorized Agent record. Never accept executable
// SVG, arbitrary remote URLs or a reference to another workspace's private file.
export function isAgentImage(value: string): boolean {
    if (value.length > Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4 + 64) return false
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
    if (!match || match[2].length % 4 !== 0) return false
    try {
        const raw = atob(match[2])
        if (raw.length > MAX_AGENT_IMAGE_BYTES || raw.length < 30) return false
        const b = (i: number) => raw.charCodeAt(i)
        let width = 0, height = 0
        if (match[1] === 'png' && raw.slice(0, 8) === '\x89PNG\r\n\x1a\n' && raw.slice(12, 16) === 'IHDR') {
            const u32 = (i: number) => b(i) * 16777216 + b(i + 1) * 65536 + b(i + 2) * 256 + b(i + 3)
            width = u32(16); height = u32(20)
        }
        else if (match[1] === 'webp' && raw.slice(0, 4) === 'RIFF' && raw.slice(8, 12) === 'WEBP') {
            const little = (i: number) => b(i) + b(i + 1) * 256 + b(i + 2) * 65536
            if (raw.slice(12, 16) === 'VP8X') {
                width = little(24) + 1; height = little(27) + 1 
            }
            else if (raw.slice(12, 16) === 'VP8L' && b(20) === 47) {
                width = 1 + ((b(21) | b(22) << 8) & 16383)
                height = 1 + ((b(22) >> 6 | b(23) << 2 | b(24) << 10) & 16383)
            }
            else if (raw.slice(12, 16) === 'VP8 ' && raw.slice(23, 26) === '\x9d\x01\x2a') {
                width = (b(26) | b(27) << 8) & 16383; height = (b(28) | b(29) << 8) & 16383
            }
        }
        else if (match[1] === 'jpeg' && b(0) === 255 && b(1) === 216) {
            for (let i = 2; i + 8 < raw.length;) {
                if (b(i) !== 255) return false
                const marker = b(i + 1), length = b(i + 2) * 256 + b(i + 3)
                if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
                    height = b(i + 5) * 256 + b(i + 6); width = b(i + 7) * 256 + b(i + 8); break
                }
                if (length < 2) return false
                i += length + 2
            }
        }
        return width > 0 && height > 0 && width <= MAX_AGENT_IMAGE_DIMENSION && height <= MAX_AGENT_IMAGE_DIMENSION
    }
    catch {
        return false 
    }
}

export const AgentImage = z.string().max(Math.ceil(MAX_AGENT_IMAGE_BYTES / 3) * 4 + 64).refine(isAgentImage, 'Choose a PNG, JPEG or WebP image up to 48 KB and 1024 × 1024 pixels.')
