import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { distributionBoundaries } from './audit-distribution-boundaries.mjs'

const root = '/candidate'
test('only actual restricted license boundaries are rejected', () => {
    for (const file of ['packages/ee/index.ts', 'packages/server/api/src/app/ee/agent.ts', 'packages/server/api/dist/src/app/ee/agent.js']) assert.equal(distributionBoundaries.isRestrictedPath({ root, target: path.join(root, file) }), true)
    for (const file of ['packages/core/shared/src/lib/ee/agent.ts', 'packages/server/worker/src/lib/execute/jobs/ee/agent.ts', 'packages/server/api/src/app/syd/index.ts']) assert.equal(distributionBoundaries.isRestrictedPath({ root, target: path.join(root, file) }), false)
})
test('static, re-export, require and dynamic imports are inventoried while comments are ignored', () => {
    const references = distributionBoundaries.importReferences({ file: 'source.ts', text: `// import 'ignored'\nimport { a } from './a'; export * from './b'; const c = require('./c'); const d = import('./d'); const e = './not-an-import';` })
    assert.deepEqual(references, ['./a', './b', './c', './d'])
})
test('artifact rejects forbidden trees and restricted resolved imports', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydekyks-boundary-'))
    try {
        const allowed = path.join(directory, 'packages/server/api/src/app/own')
        const forbidden = path.join(directory, 'packages/server/api/src/app/ee')
        fs.mkdirSync(allowed, { recursive: true }); fs.mkdirSync(forbidden, { recursive: true })
        fs.writeFileSync(path.join(allowed, 'index.ts'), `import { x } from '../ee/x'`)
        fs.writeFileSync(path.join(forbidden, 'x.ts'), 'export const x = 1')
        const source = distributionBoundaries.auditDistribution({ root: directory })
        assert.equal(source.restrictedImportEdges, 1)
        assert.equal(source.passed, false)
        const artifact = distributionBoundaries.auditDistribution({ root: directory, artifact: true })
        assert.equal(artifact.forbiddenFiles.length, 1)
        assert.equal(artifact.passed, false)
        fs.writeFileSync(path.join(allowed, 'index.ts'), 'export const own = 1')
        fs.rmSync(forbidden, { recursive: true })
        assert.equal(distributionBoundaries.auditDistribution({ root: directory, artifact: true }).passed, true)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
test('aliases cannot conceal a restricted source import', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydekyks-boundary-'))
    try {
        const allowed = path.join(directory, 'packages/server/api/src/app/own')
        fs.mkdirSync(allowed, { recursive: true })
        fs.writeFileSync(path.join(directory, 'tsconfig.base.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@internal/*': ['packages/server/api/src/app/ee/*'] } } }))
        fs.writeFileSync(path.join(allowed, 'index.ts'), "import { x } from '@internal/authentication/access'")
        const result = distributionBoundaries.auditDistribution({ root: directory })
        assert.equal(result.restrictedImportEdges, 1)
        assert.equal(result.passed, false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
test('uninspected source or artifact symlinks fail closed', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sydekyks-boundary-'))
    try {
        const allowed = path.join(directory, 'packages/server/api/src/app')
        fs.mkdirSync(allowed, { recursive: true })
        fs.symlinkSync('/outside-uninspected-source', path.join(allowed, 'linked-code'))
        const result = distributionBoundaries.auditDistribution({ root: directory, artifact: true })
        assert.equal(result.unresolvedSymlinks.length, 1)
        assert.equal(result.passed, false)
    } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
