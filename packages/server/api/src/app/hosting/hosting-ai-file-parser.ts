import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'

export const HOSTED_AI_FILE_MAX_BYTES = 20 * 1024 * 1024
export const HOSTED_AI_FILE_MAX_PAGES = 20
export const HOSTED_AI_FILE_TOKEN_BOUND = 40_000
export const HOSTED_AI_FILE_PROCESSOR = 'bounded-documents-images-v1'
export const HOSTED_AI_FILE_MIME_TYPES = [
    'text/plain', 'text/csv', 'application/json', 'text/markdown',
    'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/octet-stream',
] as const

export type PreparedAiFile = { kind: 'text' | 'image' | 'document', pageCount: number, text: string, images: { mimeType: string, data: string, width: number, height: number }[] }
export class HostedAiFileError extends Error {
    constructor(message: string, public statusCode = 400) {
        super(message)
    }
}

let activeParsers = 0
const execute = promisify(execFile)
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
    let result = value
    for (let bit = 0; bit < 8; bit++) result = (result >>> 1) ^ ((result & 1) ? 0xedb88320 : 0)
    return result >>> 0
})
function checksum(bytes: Buffer): number {
    let result = 0xffffffff
    for (const byte of bytes) result = (result >>> 8) ^ CRC_TABLE[(result ^ byte) & 255]
    return (result ^ 0xffffffff) >>> 0
}

export function strictFileBytes(data: string): Buffer {
    if (data.length === 0 || data.length > Math.ceil(HOSTED_AI_FILE_MAX_BYTES / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HostedAiFileError('Choose a valid file of at most 20 MiB.')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length === 0 || bytes.length > HOSTED_AI_FILE_MAX_BYTES || bytes.toString('base64') !== data) throw new HostedAiFileError('Choose a valid file of at most 20 MiB.')
    return bytes
}

export function preparedFileTokenBound(prepared: PreparedAiFile): number {
    return Buffer.byteLength(prepared.text, 'utf8') + prepared.images.length * 1024 + 1024
}

/** Browser MIME is a hint, never an authority for decoding uploaded bytes. */
export function resolveHostedAiFileMime(bytes: Buffer, name: string, declared: string): string {
    let detected: string | undefined
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) detected = 'image/png'
    else if (bytes[0] === 0xff && bytes[1] === 0xd8) detected = 'image/jpeg'
    else if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii'))) detected = 'image/gif'
    else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') detected = 'image/webp'
    else if (bytes.toString('ascii', 0, 5) === '%PDF-') detected = 'application/pdf'
    else if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) detected = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (declared !== 'application/octet-stream') {
        if (!(HOSTED_AI_FILE_MIME_TYPES as readonly string[]).includes(declared) || (detected && detected !== declared) || (!detected && !declared.startsWith('text/') && declared !== 'application/json')) throw new HostedAiFileError('The declared file type does not match its content.')
        return declared
    }
    if (detected) return detected
    // Unknown binary formats must not be misrepresented as plain text.
    if (!/\.(txt|csv|md|markdown|json)$/i.test(name)) throw new HostedAiFileError('This file type is not supported. Use PDF, DOCX, UTF-8 text or a supported image.')
    return /\.json$/i.test(name) ? 'application/json' : /\.csv$/i.test(name) ? 'text/csv' : /\.(md|markdown)$/i.test(name) ? 'text/markdown' : 'text/plain'
}

export async function prepareHostedAiFile(bytes: Buffer, mimeType: string): Promise<PreparedAiFile> {
    if (!(HOSTED_AI_FILE_MIME_TYPES as readonly string[]).includes(mimeType) || mimeType === 'application/octet-stream') throw new HostedAiFileError('This file type is not supported. Use a document, plain text or a supported image.')
    if (bytes.length === 0 || bytes.length > HOSTED_AI_FILE_MAX_BYTES) throw new HostedAiFileError('Choose a file of at most 20 MiB.')
    if (mimeType.startsWith('image/')) {
        const image = inspectHostedImage(bytes, mimeType)
        return parseDocumentInChild(bytes, mimeType, [{ mimeType, data: bytes.toString('base64'), ...image }])
    }
    if (mimeType.startsWith('text/') || mimeType === 'application/json') {
        let text: string
        try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        }
        catch {
            throw new HostedAiFileError('Save this text document as UTF-8, then upload it again.')
        }
        if (!text.trim() || text.includes('\0') || Buffer.byteLength(text, 'utf8') + 1024 > HOSTED_AI_FILE_TOKEN_BOUND) throw new HostedAiFileError('Use a nonempty text document within the 40,000-token input limit.')
        if (mimeType === 'application/json') {
            try {
                JSON.parse(text)
            }
            catch {
                throw new HostedAiFileError('This JSON file is not valid. Correct it before uploading.')
            }
        }
        return { kind: 'text', pageCount: 1, text, images: [] }
    }
    if (mimeType === 'application/pdf' && !bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-')) throw new HostedAiFileError('The file content is not a valid PDF.')
    const docx = mimeType !== 'application/pdf' ? inspectDocxArchive(bytes) : null
    const prepared = await parseDocumentInChild(bytes, mimeType, docx?.images)
    if (docx) {
        prepared.text += docx.supplementalText
        prepared.pageCount = docx.pageCount
    }
    if (preparedFileTokenBound(prepared) > HOSTED_AI_FILE_TOKEN_BOUND) throw new HostedAiFileError('This document exceeds the 40,000-token input limit. Split it into smaller files.')
    for (const image of prepared.images) inspectHostedImage(Buffer.from(image.data, 'base64'), image.mimeType)
    return prepared
}

/** No image decoder runs in the web process. Header dimensions and complete
 * container bounds prevent a tiny compressed image from declaring huge rasters. */
export function inspectHostedImage(bytes: Buffer, mimeType: string): { width: number, height: number } {
    let width = 0, height = 0
    const invalid = () => {
        throw new HostedAiFileError('The image is malformed, animated or too large. Use a static PNG, JPEG, GIF or WebP up to 8,192 pixels per side.')
    }
    if (mimeType === 'image/png') {
        if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid()
        let offset = 8, ended = false, imageData = false
        while (offset + 12 <= bytes.length) {
            const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
            if (size > bytes.length - offset - 12 || type === 'acTL') invalid()
            if (checksum(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) invalid()
            if (offset === 8 && (type !== 'IHDR' || size !== 13)) invalid()
            if (type === 'IHDR') {
                if (width || height) invalid(); width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12)
            }
            if (type === 'IDAT') imageData = true
            offset += size + 12
            if (type === 'IEND') {
                ended = size === 0 && offset === bytes.length; break
            }
        }
        if (!ended || !imageData) invalid()
    }
    else if (mimeType === 'image/jpeg') {
        if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) invalid()
        let offset = 2
        while (offset + 4 < bytes.length) {
            if (bytes[offset++] !== 0xff) invalid()
            while (bytes[offset] === 0xff) offset++
            if (offset + 3 > bytes.length) invalid()
            const marker = bytes[offset++], size = bytes.readUInt16BE(offset)
            if (size < 2 || offset + size > bytes.length) invalid()
            if ([0xc0, 0xc1, 0xc2].includes(marker)) {
                if (size < 8 || width || height) invalid()
                height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5)
            }
            if (marker === 0xda) break
            offset += size
        }
    }
    else if (mimeType === 'image/gif') {
        if (bytes.length < 14 || !['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) invalid()
        width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8)
        let offset = 13 + ((bytes[10] & 0x80) ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0), frames = 0, ended = false
        const skipBlocks = () => {
            while (offset < bytes.length) {
                const size = bytes[offset++]
                if (!size) return
                if (offset + size > bytes.length) invalid()
                offset += size
            }
            invalid()
        }
        while (offset < bytes.length) {
            const code = bytes[offset++]
            if (code === 0x3b) {
                ended = offset === bytes.length; break
            }
            if (code === 0x21) {
                offset++; skipBlocks(); continue
            }
            if (code !== 0x2c || offset + 9 >= bytes.length || ++frames > 1) invalid()
            const frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6), packed = bytes[offset + 8]
            if (frameWidth > width || frameHeight > height) invalid()
            offset += 9 + ((packed & 0x80) ? 3 * 2 ** ((packed & 7) + 1) : 0)
            offset++; skipBlocks()
        }
        if (!ended || frames !== 1) invalid()
    }
    else if (mimeType === 'image/webp') {
        if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid()
        let offset = 12
        while (offset + 8 <= bytes.length) {
            const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
            if (start + size > bytes.length || type === 'ANIM' || type === 'ANMF') invalid()
            if (type === 'VP8X' && size >= 10) {
                if (bytes[start] & 2) invalid(); width = bytes.readUIntLE(start + 4, 3) + 1; height = bytes.readUIntLE(start + 7, 3) + 1
            }
            if (type === 'VP8 ' && size >= 10) {
                if (bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) invalid(); const w = bytes.readUInt16LE(start + 6) & 0x3fff, h = bytes.readUInt16LE(start + 8) & 0x3fff; if (width && (width !== w || height !== h)) invalid(); width = w; height = h
            }
            if (type === 'VP8L' && size >= 5) {
                if (bytes[start] !== 0x2f) invalid(); const bits = bytes.readUInt32LE(start + 1), w = (bits & 0x3fff) + 1, h = ((bits >>> 14) & 0x3fff) + 1; if (width && (width !== w || height !== h)) invalid(); width = w; height = h
            }
            offset = start + size + (size & 1)
        }
        if (offset !== bytes.length) invalid()
    }
    else invalid()
    if (!width || !height || width > 8192 || height > 8192 || width * height > 20_000_000) invalid()
    return { width, height }
}

/** Validate every DOCX entry before Mammoth sees it, including unrelated
 * compressed entries. Never extract paths or follow document relationships. */
export function inspectDocxArchive(bytes: Buffer): { images: PreparedAiFile['images'], supplementalText: string, pageCount: number } {
    if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new HostedAiFileError('The file content is not a valid Word document.')
    let end = -1
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
        if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
            end = offset; break
        }
    }
    if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new HostedAiFileError('Use an ordinary, unencrypted Word document.')
    const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16)
    if (!count || count > 200 || directoryOffset + directorySize !== end) throw new HostedAiFileError('This Word document is too complex. Export a smaller PDF or text file.')
    let offset = directoryOffset, total = 0, document = false, types = false, supplementalText = '', pageCount = 1
    const images: PreparedAiFile['images'] = []
    const names = new Set<string>()
    for (let index = 0; index < count; index++) {
        if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new HostedAiFileError('The Word document archive is malformed.')
        const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), packed = bytes.readUInt32LE(offset + 20), unpacked = bytes.readUInt32LE(offset + 24), nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32), local = bytes.readUInt32LE(offset + 42)
        if ((flags & 1) || ![0, 8].includes(method) || unpacked > 4 * 1024 * 1024 || (total += unpacked) > 12 * 1024 * 1024 || offset + 46 + nameSize + extraSize + commentSize > end || local + 30 > directoryOffset) throw new HostedAiFileError('The Word document exceeds safe extraction limits.')
        const name = bytes.toString('utf8', offset + 46, offset + 46 + nameSize)
        if (names.has(name) || name.includes('..') || name.includes('\\') || name.startsWith('/') || bytes.readUInt32LE(local) !== 0x04034b50) throw new HostedAiFileError('The Word document archive is malformed.')
        names.add(name)
        const dataStart = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
        if (dataStart + packed > directoryOffset || bytes.readUInt16LE(local + 8) !== method || bytes.toString('utf8', local + 30, local + 30 + bytes.readUInt16LE(local + 26)) !== name) throw new HostedAiFileError('The Word document archive is malformed.')
        let content: Buffer
        try {
            content = method === 0 ? bytes.subarray(dataStart, dataStart + packed) : inflateRawSync(bytes.subarray(dataStart, dataStart + packed), { maxOutputLength: 4 * 1024 * 1024 })
        }
        catch {
            throw new HostedAiFileError('The Word document could not be safely decompressed.')
        }
        if (content.length !== unpacked || checksum(content) !== bytes.readUInt32LE(offset + 16) || (/\.(xml|rels)$/i.test(name) && /<!DOCTYPE|<!ENTITY/i.test(content.toString('utf8')))) throw new HostedAiFileError('The Word document contains unsupported or corrupt XML.')
        const linkedMedia = /\.rels$/i.test(name) && (content.toString('utf8').match(/<Relationship\b[^>]*>/g) ?? []).some(relationship => /TargetMode=["']External["']/i.test(relationship) && /relationships\/(image|oleObject|package)/i.test(relationship))
        if (name.startsWith('word/embeddings/') || linkedMedia) throw new HostedAiFileError('This Word document contains embedded objects or externally linked media. Export it as a PDF first.')
        if (name === 'word/document.xml') {
            document = true
            const xml = content.toString('utf8')
            pageCount = Math.max(pageCount, 1 + (xml.match(/<w:lastRenderedPageBreak\b/g)?.length ?? 0), 1 + (xml.match(/w:type=["']page["']/g)?.length ?? 0))
        }
        if (name === 'docProps/app.xml') {
            const declared = /<Pages>(\d+)<\/Pages>/.exec(content.toString('utf8'))
            if (declared) pageCount = Math.max(pageCount, Number(declared[1]))
        }
        if (/^word\/(header|footer|footnotes|endnotes)[^/]*\.xml$/.test(name)) {
            supplementalText += '\n' + xmlText(content.toString('utf8'))
        }
        if (name.startsWith('word/media/')) {
            const mime = name.endsWith('.png') ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.gif$/i.test(name) ? 'image/gif' : /\.webp$/i.test(name) ? 'image/webp' : null
            if (!mime) throw new HostedAiFileError('This Word document contains unsupported media. Export it as a PDF first.')
            const dimensions = inspectHostedImage(content, mime)
            images.push({ mimeType: mime, data: content.toString('base64'), ...dimensions })
            if (images.length > 20) throw new HostedAiFileError('This Word document contains too many images. Split it into smaller files.')
        }
        if (name === '[Content_Types].xml') types = true
        offset += 46 + nameSize + extraSize + commentSize
    }
    if (!document || !types || offset !== end) throw new HostedAiFileError('The file content is not a complete Word document.')
    if (pageCount > HOSTED_AI_FILE_MAX_PAGES) throw new HostedAiFileError('Use a Word document of at most 20 declared pages, or split it into smaller files.')
    if (images.reduce((sum, image) => sum + image.width * image.height, 0) > 20_000_000) throw new HostedAiFileError('This Word document contains too many image pixels. Split it into smaller files.')
    return { images, supplementalText, pageCount }
}

function xmlText(xml: string): string {
    let text = '', inside = false
    for (const character of xml) {
        if (character === '<') {
            inside = true; text += ' '; continue
        }
        if (character === '>') {
            inside = false; continue
        }
        if (!inside) text += character
    }
    return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, '\'')
}

async function parseDocumentInChild(bytes: Buffer, mimeType: string, images: PreparedAiFile['images'] = []): Promise<PreparedAiFile> {
    if (activeParsers >= 2) throw new HostedAiFileError('Document processing is busy. Try again shortly.', 429)
    activeParsers++
    const child = spawn(process.execPath, ['--max-old-space-size=192', '--eval', DOCUMENT_WORKER], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env['PATH'] ?? '', NODE_OPTIONS: '' } })
    try {
        return await new Promise<PreparedAiFile>((resolve, reject) => {
            let settled = false, monitoring = false
            const finish = (error?: Error, result?: PreparedAiFile) => {
                if (settled) return
                settled = true; clearTimeout(timeout); clearInterval(monitor)
                child.kill('SIGKILL')
                if (error) reject(error)
                else resolve(result!)
            }
            const timeout = setTimeout(() => finish(new HostedAiFileError('This document took too long to process. Use a smaller or simpler file.')), 15_000)
            const monitor = setInterval(() => {
                if (monitoring || settled || !child.pid) return
                monitoring = true
                void childRss(child.pid).then(bytesUsed => {
                    if (bytesUsed > 384 * 1024 * 1024) finish(new HostedAiFileError('This document needs too much memory. Use a smaller file.'))
                }).catch(() => finish(new HostedAiFileError('Safe document processing is unavailable. Ask your administrator to check the runtime.'))).finally(() => {
                    monitoring = false
                })
            }, 100)
            child.once('error', () => finish(new HostedAiFileError('Safe document processing is unavailable. Try again later.')))
            child.once('exit', () => finish(new HostedAiFileError('This document could not be safely processed. Use a smaller or simpler file.')))
            child.once('message', (message: unknown) => {
                const result = message as { ok?: boolean, data?: PreparedAiFile, error?: string }
                if (!result.ok || !result.data) finish(new HostedAiFileError(result.error === 'SCANNED_RENDERER_UNAVAILABLE' ? 'Scanned PDF rendering is unavailable in this runtime. Ask your administrator to install the documented renderer.' : result.error === 'DOCUMENT_LIMIT' ? 'Use a document with at most 20 pages and 40,000 input tokens. Split this file before uploading.' : 'The document is invalid, encrypted or cannot be completely understood. Export a plain PDF or text file and try again.'))
                else finish(undefined, result.data)
            })
            const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))
            child.send({ bytes: bytes.toString('base64'), mimeType, images, pdfModule: require.resolve('pdfjs-dist/legacy/build/pdf.mjs'), fontPath: path.join(pdfRoot, 'standard_fonts') + path.sep, wasmPath: path.join(pdfRoot, 'wasm') + path.sep, canvasModule: require.resolve('@napi-rs/canvas'), mammothModule: require.resolve('mammoth') })
        })
    }
    finally {
        activeParsers--
    }
}

async function childRss(pid: number): Promise<number> {
    if (process.platform === 'linux') {
        const status = await readFile(`/proc/${pid}/status`, 'utf8')
        const match = /^VmRSS:\s+(\d+) kB$/m.exec(status)
        if (!match) throw new Error('No process memory measurement')
        return Number(match[1]) * 1024
    }
    const { stdout } = await execute('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1000, maxBuffer: 1024 })
    const value = Number(stdout.trim())
    if (!Number.isFinite(value)) throw new Error('No process memory measurement')
    return value * 1024
}

// Fixed source only; uploaded bytes are data, never evaluated. Separate process
// protects the web process from synchronous parser loops and native renderer OOM.
const DOCUMENT_WORKER = String.raw`
const { pathToFileURL } = require('node:url');
function validatePng(bytes) {
 const depth = bytes[24], color = bytes[25], interlace = bytes[28];
 const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
 const depths = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] }[color];
 if (!channels || !depths.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) throw Error('DOCUMENT_INVALID');
 const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), passes = [];
 const patterns = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
 let expected = 0;
 for (const [x,y,dx,dy] of patterns) {
  const columns = Math.max(0, Math.ceil((width-x)/dx)), rows = Math.max(0, Math.ceil((height-y)/dy));
  if (columns && rows) { const stride = Math.ceil(columns*channels*depth/8)+1; passes.push([rows,stride]); expected += rows*stride; }
 }
 if (expected > 160000000) throw Error('DOCUMENT_LIMIT');
 const chunks = [];
 for (let offset=8; offset+12<=bytes.length;) { const size=bytes.readUInt32BE(offset); if(bytes.toString('ascii',offset+4,offset+8)==='IDAT') chunks.push(bytes.subarray(offset+8,offset+8+size)); offset += size+12; }
 const inflated = require('node:zlib').inflateSync(Buffer.concat(chunks), { maxOutputLength: expected });
 if (inflated.length !== expected) throw Error('DOCUMENT_INVALID');
 let offset=0;
 for(const [rows,stride] of passes) for(let row=0;row<rows;row++) { if(inflated[offset]>4) throw Error('DOCUMENT_INVALID'); offset += stride; }
}
process.once('message', async (input) => {
 try {
  const bytes = Uint8Array.from(Buffer.from(input.bytes, 'base64'));
  let text = '', images = [], pageCount = 1;
  if (input.mimeType === 'application/pdf') {
   const canvas = require(input.canvasModule);
   globalThis.DOMMatrix = canvas.DOMMatrix; globalThis.ImageData = canvas.ImageData; globalThis.Path2D = canvas.Path2D;
   const pdf = await import(pathToFileURL(input.pdfModule).href);
   let incomplete = false;
   console.warn = (...args) => { if (/exceed|too large|cannot|unable|error/i.test(args.join(' '))) incomplete = true; };
   const document = await pdf.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false, standardFontDataUrl: input.fontPath, wasmUrl: input.wasmPath, maxImageSize: 20_000_000, stopAtErrors: true }).promise;
   pageCount = document.numPages;
   if (pageCount < 1 || pageCount > 20) throw Error('DOCUMENT_LIMIT');
   let pixels = 0, imageBytes = 0;
   for (let number = 1; number <= pageCount; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    const pageText = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
    text += '\n[Page ' + number + ']\n' + pageText;
    if (Buffer.byteLength(text, 'utf8') + images.length * 1024 + 1024 > 40000) throw Error('DOCUMENT_LIMIT');
    // Rendering every page preserves diagrams and scans, rather than silently
    // trusting a PDF text layer which may omit most visible content.
    const original = page.getViewport({ scale: 1 });
    if (!Number.isFinite(original.width) || !Number.isFinite(original.height) || original.width <= 0 || original.height <= 0 || original.width > 20000 || original.height > 20000) throw Error('DOCUMENT_LIMIT');
    const viewport = page.getViewport({ scale: Math.min(1.5, 1300 / Math.max(original.width, original.height), Math.sqrt((20_000_000 / pageCount - 5000) / (original.width * original.height))) });
    const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
    pixels += width * height;
    if (pixels > 20_000_000) throw Error('DOCUMENT_LIMIT');
    const surface = canvas.createCanvas(width, height);
    await page.render({ canvas: surface, canvasContext: surface.getContext('2d'), viewport }).promise;
    const buffer = surface.toBuffer('image/png'); imageBytes += buffer.length;
    if (imageBytes > 20971520 || incomplete) throw Error('DOCUMENT_LIMIT');
    images.push({ mimeType: 'image/png', data: buffer.toString('base64'), width, height });
    page.cleanup(); surface.width = 1; surface.height = 1;
   }
   await document.destroy();
  } else if (!input.mimeType.startsWith('image/')) {
   const mammoth = require(input.mammothModule);
   const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) }, { externalFileAccess: false });
   text = result.value;
   if (result.messages.some(message => message.type === 'warning' || message.type === 'error')) throw Error('DOCUMENT_INCOMPLETE');
  }
  if (input.images.length) {
   const canvas = require(input.canvasModule);
   let encodedBytes = 0;
   for (const image of input.images) {
    const source = Buffer.from(image.data, 'base64');
    if (image.mimeType === 'image/png') validatePng(source);
    const decoded = await canvas.loadImage(source);
    if (decoded.width !== image.width || decoded.height !== image.height) throw Error('DOCUMENT_INVALID');
    const scale = Math.min(1, 1300 / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale)), height = Math.max(1, Math.round(image.height * scale));
    const surface = canvas.createCanvas(width, height);
    surface.getContext('2d').drawImage(decoded, 0, 0, width, height);
    const buffer = surface.toBuffer('image/png'); encodedBytes += buffer.length;
    if (encodedBytes > 20971520) throw Error('DOCUMENT_LIMIT');
    images.push({ mimeType: 'image/png', data: buffer.toString('base64'), width, height });
    surface.width = 1; surface.height = 1;
   }
  }
  if ((!text.trim() && !images.length) || Buffer.byteLength(text, 'utf8') + images.length * 1024 + 1024 > 40000) throw Error('DOCUMENT_LIMIT');
  process.send({ ok: true, data: { kind: input.mimeType.startsWith('image/') ? 'image' : 'document', pageCount, text, images } });
 } catch (error) { process.send({ ok: false, error: error && error.message === 'DOCUMENT_LIMIT' ? 'DOCUMENT_LIMIT' : 'DOCUMENT_INVALID' }); }
});
`
