import { deflateRawSync, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspectDocxArchive, inspectHostedImage, prepareHostedAiFile, preparedFileTokenBound, resolveHostedAiFileMime, strictFileBytes } from '../../src/app/hosting/hosting-ai-file-parser'

function pngChunk(type: string, bytes: Buffer): Buffer {
    const head = Buffer.alloc(4); head.writeUInt32BE(bytes.length)
    const data = Buffer.concat([Buffer.from(type), bytes]), checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(data))
    return Buffer.concat([head, data, checksum])
}
const pngHeader = Buffer.alloc(13); pngHeader.writeUInt32BE(1); pngHeader.writeUInt32BE(1, 4); pngHeader[8] = 8; pngHeader[9] = 2
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', pngHeader), pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), pngChunk('IEND', Buffer.alloc(0))])

/** A tiny real PDF with a text layer and a visible vector shape. */
function pdf(pages = 1): Buffer {
    const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(' ')}] >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    for (let i = 0; i < pages; i++) {
        objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
        const content = 'BT /F1 16 Tf 20 350 Td (Invoice total 123) Tj ET 20 20 100 100 re f'
        objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
    }
    let output = '%PDF-1.4\n', offsets = [0]
    objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` })
    const xref = Buffer.byteLength(output)
    output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(output)
}

function crc32(bytes: Buffer): number {
    let crc = 0xffffffff
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
    return (crc ^ 0xffffffff) >>> 0
}
function zip(entries: [string, string | Buffer][]): Buffer {
    const locals: Buffer[] = [], central: Buffer[] = []
    let offset = 0
    for (const [name, value] of entries) {
        const content = Buffer.isBuffer(value) ? value : Buffer.from(value), packed = deflateRawSync(content), filename = Buffer.from(name), crc = crc32(content)
        const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26)
        const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(packed.length, 20); directory.writeUInt32LE(content.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42)
        locals.push(local, filename, packed); central.push(directory, filename); offset += local.length + filename.length + packed.length
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, directory, end])
}
function docx(extra: [string, string | Buffer][] = []): Buffer {
    return zip([
        ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
        ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
        ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Invoice total 123</w:t></w:r></w:p></w:body></w:document>'],
        ...extra,
    ])
}

describe('bounded, actual-byte AI attachment processing', () => {
    it('accepts canonical base64 only, before decoding large request bodies', () => {
        expect(strictFileBytes(Buffer.from('hello').toString('base64')).toString()).toBe('hello')
        for (const value of ['', 'aGVsbG8', 'aGVsbG8=\n', '!!!!', 'YQ==junk', 'YR==']) expect(() => strictFileBytes(value)).toThrow()
    })
    it('infers empty-browser MIME from bytes and rejects spoofed declarations and unknown binaries', () => {
        expect(resolveHostedAiFileMime(png, 'picture.bin', 'application/octet-stream')).toBe('image/png')
        expect(resolveHostedAiFileMime(Buffer.from('{}'), 'record.json', 'application/octet-stream')).toBe('application/json')
        expect(() => resolveHostedAiFileMime(png, 'pretend.txt', 'text/plain')).toThrow('does not match')
        expect(() => resolveHostedAiFileMime(Buffer.from([1, 2, 3]), 'unknown.exe', 'application/octet-stream')).toThrow('not supported')
    })
    it('bounds UTF-8 text without truncating and validates JSON', async () => {
        expect((await prepareHostedAiFile(Buffer.from('Important invoice'), 'text/plain')).text).toBe('Important invoice')
        await expect(prepareHostedAiFile(Buffer.from([0xff]), 'text/plain')).rejects.toThrow('UTF-8')
        await expect(prepareHostedAiFile(Buffer.from('a\0b'), 'text/plain')).rejects.toThrow('nonempty')
        await expect(prepareHostedAiFile(Buffer.alloc(40_000, 65), 'text/plain')).rejects.toThrow('40,000')
        await expect(prepareHostedAiFile(Buffer.from('{broken'), 'application/json')).rejects.toThrow('not valid')
    })
    it('rejects large declared image rasters and incomplete containers before native decoding', () => {
        expect(inspectHostedImage(png, 'image/png')).toEqual({ width: 1, height: 1 })
        const huge = Buffer.from(png); huge.writeUInt32BE(100_000, 16)
        expect(() => inspectHostedImage(huge, 'image/png')).toThrow('too large')
        expect(() => inspectHostedImage(png.subarray(0, -12), 'image/png')).toThrow('malformed')
    })
    it('actually decodes and normalizes supported images, rejecting corrupt compressed bytes', async () => {
        const image = await prepareHostedAiFile(png, 'image/png')
        expect(image).toMatchObject({ kind: 'image', pageCount: 1, text: '', images: [{ mimeType: 'image/png', width: 1, height: 1 }] })
        expect(preparedFileTokenBound(image)).toBe(2048)
        const corrupt = Buffer.from(png); corrupt.fill(0, 41, 50)
        await expect(prepareHostedAiFile(corrupt, 'image/png')).rejects.toThrow()
        const invalidDeflate = Buffer.concat([png.subarray(0, 33), pngChunk('IDAT', Buffer.from([0, 0, 0, 0])), pngChunk('IEND', Buffer.alloc(0))])
        // The chunk CRC is valid; bounded inflation must still reject it rather
        // than accepting a native decoder's tolerant blank-image fallback.
        expect(inspectHostedImage(invalidDeflate, 'image/png')).toEqual({ width: 1, height: 1 })
        await expect(prepareHostedAiFile(invalidDeflate, 'image/png')).rejects.toThrow()
    }, 20_000)
    it('normalizes actual JPEG, WebP and static GIF bytes and resizes large images before supplier input', async () => {
        const { createCanvas } = await import('@napi-rs/canvas')
        const canvas = createCanvas(1500, 2)
        canvas.getContext('2d').fillRect(0, 0, 1500, 2)
        for (const mimeType of ['image/jpeg', 'image/webp'] as const) {
            const document = await prepareHostedAiFile(canvas.toBuffer(mimeType), mimeType)
            expect(document.images[0]).toMatchObject({ mimeType: 'image/png', width: 1300 })
        }
        const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
        expect((await prepareHostedAiFile(gif, 'image/gif')).images[0]).toMatchObject({ mimeType: 'image/png', width: 1, height: 1 })
    }, 40_000)
    it('extracts and actually renders PDF pages so scans/diagrams are not silently omitted', async () => {
        const document = await prepareHostedAiFile(pdf(), 'application/pdf')
        expect(document.kind).toBe('document'); expect(document.pageCount).toBe(1)
        expect(document.text).toContain('Invoice total 123'); expect(document.images).toHaveLength(1)
        expect(inspectHostedImage(Buffer.from(document.images[0].data, 'base64'), 'image/png')).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
        expect(document.images[0].width).toBeLessThanOrEqual(1300)
        await expect(prepareHostedAiFile(pdf(21), 'application/pdf')).rejects.toThrow('20 pages')
        await expect(prepareHostedAiFile(Buffer.from('%PDF-invalid'), 'application/pdf')).rejects.toThrow()
    }, 40_000)
    it('extracts real Word text and includes bounded embedded images', async () => {
        const document = await prepareHostedAiFile(docx([['word/media/image1.png', png]]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        expect(document.text).toContain('Invoice total 123'); expect(document.images).toHaveLength(1)
    }, 20_000)
    it('rejects archive bombs, path traversal, entities, linked media and hidden embedded objects before extraction', () => {
        for (const bytes of [
            docx([['word/huge.txt', Buffer.alloc(4 * 1024 * 1024 + 1)]]),
            docx([['../secret', 'x']]),
            docx([['word/header1.xml', '<!DOCTYPE x [<!ENTITY bad "x">]><x>&bad;</x>']]),
            docx([['word/embeddings/object1.bin', 'hidden']]),
            docx([['word/_rels/document.xml.rels', '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="https://internal.invalid/private"/></Relationships>']]),
        ]) expect(() => inspectDocxArchive(bytes)).toThrow()
        const badChecksum = docx()
        const end = badChecksum.length - 22, central = badChecksum.readUInt32LE(end + 16)
        badChecksum.writeUInt32LE(0, central + 16)
        expect(() => inspectDocxArchive(badChecksum)).toThrow('corrupt')
    })
})
