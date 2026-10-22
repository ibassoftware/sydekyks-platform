import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// A backend-only update may reuse an already-reviewed Linux runtime image.
// Never copy local node_modules/native dependencies into a production image.
const [baseRevision, baseImage, destination] = process.argv.slice(2);
if (!baseRevision || !/^sha256:[a-f0-9]{64}$/.test(baseImage ?? '') || !destination) {
    throw new Error('Usage: node scripts/package-backend-patch.mjs BASE_REVISION sha256:IMAGE_ID NEW_PRIVATE_DIRECTORY');
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('Commit and verify the source before packaging');
const sourceRevision = git('rev-parse', 'HEAD');
const changed = git('diff', '--name-only', `${baseRevision}..HEAD`).split('\n').filter(Boolean);
const roots = ['packages/server/api', 'packages/server/worker', 'packages/core/execution'];
const permittedOther = /^(docs\/|deploy\/|scripts\/|packages\/(server\/(api|worker)|core\/execution)\/(test|tests)\/)/;
const sources = [];
for (const file of changed) {
    const root = roots.find(candidate => file.startsWith(`${candidate}/src/`));
    if (root && file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        if (!fs.existsSync(file)) throw new Error(`Deleted source needs a full build: ${file}`);
        const compiled = `${root}/dist/${file.slice(root.length + 1).replace(/\.ts$/, '.js')}`;
        if (!fs.existsSync(compiled) || fs.statSync(compiled).mtimeMs < fs.statSync(file).mtimeMs) throw new Error(`Compile current source first: ${file}`);
        sources.push({ source: file, compiled });
    } else if (!permittedOther.test(file)) {
        throw new Error(`A full image build is required for this change: ${file}`);
    }
}
if (!sources.length) throw new Error('No backend changes to package');
fs.mkdirSync(destination, { mode: 0o700 });
const manifest = { sourceRevision, baseRevision: git('rev-parse', baseRevision), baseImage, files: [] };
for (const { source, compiled } of sources) {
    const data = fs.readFileSync(compiled), target = path.join(destination, 'payload', compiled);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    manifest.files.push({ source, compiled, sha256: createHash('sha256').update(data).digest('hex') });
}
fs.writeFileSync(path.join(destination, 'payload', 'backend-patch-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(destination, 'Dockerfile'), `FROM ${baseImage}\nWORKDIR /usr/src/app\nCOPY payload/ ./\nLABEL org.opencontainers.image.revision="${sourceRevision}" org.sydekyks.base-revision="${manifest.baseRevision}"\n`);
console.log(JSON.stringify({ sourceRevision, changedModules: sources.length, destination }));
