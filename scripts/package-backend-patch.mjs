import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Reuse only an exact reviewed Linux image; never copy local native dependencies.
const args = process.argv.slice(2);
const includeWeb = args.at(-1) === '--include-web';
if (includeWeb) args.pop();
const [baseRevision, baseImage, destination] = args;
if (args.length !== 3 || !baseRevision || !/^sha256:[a-f0-9]{64}$/.test(baseImage ?? '') || !destination) {
    throw new Error('Usage: node scripts/package-backend-patch.mjs BASE_REVISION sha256:IMAGE_ID NEW_PRIVATE_DIRECTORY [--include-web]');
}
const git = (...values) => execFileSync('git', values, { encoding: 'utf8' }).trim();
const sourceRevision = git('rev-parse', 'HEAD');
const assertCleanSource = () => {
    if (git('status', '--porcelain') || git('rev-parse', 'HEAD') !== sourceRevision) throw new Error('Commit and verify the source before packaging; source changed during packaging');
};
assertCleanSource();
const resolvedBase = git('rev-parse', '--verify', '--end-of-options', `${baseRevision}^{commit}`);
execFileSync('git', ['merge-base', '--is-ancestor', resolvedBase, sourceRevision]);
const changed = git('diff', '--name-only', '-z', `${resolvedBase}..${sourceRevision}`).split('\0').filter(Boolean);
const roots = ['packages/server/api', 'packages/server/worker', 'packages/core/execution'];
const permittedOther = /^(docs\/|deploy\/|scripts\/|packages\/(server\/(api|worker)|core\/execution)\/(test|tests)\/)/;
const sources = [];
let changedWeb = false;
function noSymlinks(file) {
    let current = process.cwd();
    for (const part of file.split(path.sep)) {
        current = path.join(current, part);
        if (!fs.existsSync(current) && !fs.lstatSync(current, { throwIfNoEntry: false })) break;
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Symlink is not a verified artifact: ${file}`);
    }
}
function regularFiles(directory) {
    noSymlinks(directory);
    const files = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Symlink is not a verified artifact: ${file}`);
        if (entry.name === 'node_modules') throw new Error(`Dependencies cannot be copied into an artifact: ${file}`);
        if (entry.isDirectory()) files.push(...regularFiles(file));
        else if (entry.isFile()) files.push(file);
        else throw new Error(`Not a regular artifact file: ${file}`);
    }
    return files;
}
for (const file of changed) {
    noSymlinks(file);
    if (!fs.existsSync(file)) throw new Error(`Deleted source needs a full build: ${file}`);
    const root = roots.find(candidate => file.startsWith(`${candidate}/src/`));
    if (root && file.endsWith('.ts') && !file.endsWith('.d.ts')) {
        const compiled = `${root}/dist/${file.slice(root.length + 1).replace(/\.ts$/, '.js')}`;
        noSymlinks(compiled);
        if (!fs.existsSync(compiled) || !fs.statSync(compiled).isFile() || fs.statSync(compiled).mtimeMs < fs.statSync(file).mtimeMs) throw new Error(`Compile current source first: ${file}`);
        sources.push({ source: file, compiled });
    } else if (includeWeb && /^packages\/web\/src\/.+\.tsx?$/.test(file) && !file.endsWith('.d.ts')) {
        changedWeb = true;
    } else if (!(includeWeb && /^packages\/web\/tests?\/.+\.tsx?$/.test(file)) && !permittedOther.test(file)) {
        throw new Error(`A full image build is required for this change: ${file}`);
    }
}
if (!sources.length && !(includeWeb && changedWeb)) throw new Error('No backend or opted-in web changes to package');
const webDirectory = 'dist/packages/web';
let webFiles = [];
if (includeWeb) {
    // Inspect both inputs and output ancestry before removing only generated web
    // assets. A fresh build cannot inherit a stale index, chunk or source map.
    for (const directory of ['packages/web/src', 'packages/web/public']) if (fs.existsSync(directory)) regularFiles(directory);
    for (const file of ['packages/web/index.html', 'packages/web/vite.config.mts']) noSymlinks(file);
    noSymlinks(webDirectory);
    fs.rmSync(webDirectory, { recursive: true, force: true });
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'packages/web/vite.config.mts'], { stdio: 'inherit', env: { ...process.env, AP_BUILD_SOURCEMAP: 'false' } });
    assertCleanSource();
    webFiles = regularFiles(webDirectory).sort();
    if (!webFiles.includes(`${webDirectory}/index.html`)) throw new Error('Fresh web build did not produce index.html');
    if (webFiles.some(file => file.endsWith('.map'))) throw new Error('Web source maps must not enter the patch');
}
// Build hooks may not replace/dirty the committed source, or make backend emit
// stale while the web build runs. Recheck before producing a deployable context.
assertCleanSource();
for (const { source, compiled } of sources) {
    noSymlinks(source); noSymlinks(compiled);
    if (fs.statSync(compiled).mtimeMs < fs.statSync(source).mtimeMs) throw new Error(`Compile current source first: ${source}`);
}
fs.mkdirSync(destination, { mode: 0o700 });
const baseAlias = `sydekyks:patch-base-${baseImage.slice(7)}`;
const manifest = { kind: includeWeb ? 'backend+web' : 'backend', sourceRevision, baseRevision: resolvedBase, baseImage, baseAlias, files: [] };
for (const entry of [...sources, ...webFiles.map(compiled => ({ source: 'packages/web', compiled }))]) {
    const data = fs.readFileSync(entry.compiled), target = path.join(destination, 'payload', entry.compiled);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, data, { mode: 0o600 });
    manifest.files.push({ ...entry, sha256: createHash('sha256').update(data).digest('hex') });
}
assertCleanSource();
fs.writeFileSync(path.join(destination, 'payload', 'backend-patch-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
// BuildKit requires an alias tagged from the exact manifest.baseImage on host.
fs.writeFileSync(path.join(destination, 'Dockerfile'), `FROM ${baseAlias}\nWORKDIR /usr/src/app\n${includeWeb ? 'RUN rm -rf dist/packages/web\n' : ''}COPY payload/ ./\nLABEL org.opencontainers.image.revision="${sourceRevision}" org.sydekyks.base-revision="${manifest.baseRevision}"\n`, { mode: 0o600 });
assertCleanSource();
console.log(JSON.stringify({ kind: manifest.kind, sourceRevision, changedModules: sources.length, webFiles: webFiles.length, destination }));
