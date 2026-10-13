import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { pathToFileURL } from 'node:url'

function isRestrictedPath({ target, root }) {
    const relative = path.relative(root, target).split(path.sep).join('/')
    return ['packages/ee', 'packages/server/api/src/app/ee', 'packages/server/api/dist/src/app/ee'].some(prefix => relative === prefix || relative.startsWith(`${prefix}/`))
}

function importReferences({ text, file }) {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const references = []
    function visit(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) references.push(node.moduleSpecifier.text)
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require') && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) references.push(node.arguments[0].text)
        ts.forEachChild(node, visit)
    }
    visit(ast)
    return references
}

function aliasTargets({ root, specifier, aliases, baseUrl }) {
    return Object.entries(aliases).flatMap(([alias, targets]) => {
        const wildcard = alias.indexOf('*')
        if (wildcard === -1) return alias === specifier ? targets.map(target => path.resolve(root, baseUrl, target)) : []
        const prefix = alias.slice(0, wildcard)
        const suffix = alias.slice(wildcard + 1)
        if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return []
        const matched = specifier.slice(prefix.length, suffix.length ? -suffix.length : undefined)
        return targets.map(target => path.resolve(root, baseUrl, target.replace('*', matched)))
    })
}

function auditDistribution({ root, artifact = false }) {
    const imports = []
    const forbiddenFiles = []
    const unresolvedSymlinks = []
    const configPath = path.join(root, 'tsconfig.base.json')
    const config = fs.existsSync(configPath) ? ts.readConfigFile(configPath, ts.sys.readFile).config : {}
    const aliases = config.compilerOptions?.paths ?? {}
    const baseUrl = config.compilerOptions?.baseUrl ?? '.'
    const entries = artifact ? [root] : ['packages/server/api/src', 'packages/server/worker/src', 'packages/server/engine/src', 'packages/server/utils/src', 'packages/web/src', 'packages/core', 'packages/pieces/common/src', 'packages/pieces/framework/src'].map(dir => path.join(root, dir))
    function walk(directory) {
        if (!fs.existsSync(directory)) return
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (['node_modules', '.git', '.turbo'].includes(entry.name)) continue
            const file = path.join(directory, entry.name)
            if (entry.isSymbolicLink()) { unresolvedSymlinks.push(path.relative(root, file)); continue }
            if (isRestrictedPath({ root, target: file })) {
                if (artifact) forbiddenFiles.push(path.relative(root, file))
                continue
            }
            if (entry.isDirectory()) { walk(file); continue }
            if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue
            for (const specifier of importReferences({ text: fs.readFileSync(file, 'utf8'), file })) {
                const target = specifier.startsWith('.') ? path.resolve(path.dirname(file), specifier) : path.resolve(root, specifier)
                const aliased = aliasTargets({ root, specifier, aliases, baseUrl }).find(target => isRestrictedPath({ root, target }))
                if (aliased || isRestrictedPath({ root, target }) || specifier === 'ee-embed-sdk' || specifier.startsWith('ee-embed-sdk/') || specifier.startsWith('@activepieces/ee')) imports.push({ file: path.relative(root, file), specifier, target: path.relative(root, aliased ?? target) })
            }
        }
    }
    for (const directory of entries) walk(directory)
    return { restrictedImportEdges: imports.length, importingFiles: new Set(imports.map(item => item.file)).size, forbiddenFiles, unresolvedSymlinks, imports, passed: imports.length === 0 && forbiddenFiles.length === 0 && unresolvedSymlinks.length === 0 }
}

export const distributionBoundaries = { isRestrictedPath, importReferences, auditDistribution }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const root = path.resolve(process.argv[2] || '.')
    const result = auditDistribution({ root, artifact: process.argv.includes('--artifact') })
    const outputIndex = process.argv.indexOf('--output')
    if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], `${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`${JSON.stringify({ passed: result.passed, restrictedImportEdges: result.restrictedImportEdges, importingFiles: result.importingFiles, forbiddenFiles: result.forbiddenFiles.length, unresolvedSymlinks: result.unresolvedSymlinks.length })}\n`)
    process.exitCode = result.passed ? 0 : 1
}
