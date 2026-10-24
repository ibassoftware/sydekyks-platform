import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = fs.readFileSync(new URL('./package-backend-patch.mjs', import.meta.url), 'utf8');
const image = `sha256:${'a'.repeat(64)}`;
const api = 'packages/server/api/src/app/example.ts';
const compiled = 'packages/server/api/dist/src/app/example.js';
const web = 'packages/web/src/lib/api.ts';
function fixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sydekyks-patch-'));
    const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture'); };
    try {
        git('init', '-q');
        write('.gitignore', 'node_modules/\ndist/\n**/dist/\nartifact/\n');
        write('scripts/package-backend-patch.mjs', script);
        write(api, 'export const value = 1;\n'); write(web, 'export const auth = false;\n');
        write('packages/web/vite.config.mts', 'export default {};\n');
        write('packages/web/index.html', '<html>source</html>');
        write('package.json', '{"name":"fixture"}'); write('bun.lock', 'fixture lock');
        commit();
        const base = git('rev-parse', 'HEAD');
        write(api, 'export const value = 2;\n'); write(web, 'export const auth = true;\n');
        commit();
        write(compiled, 'export const value = 2;\n');
        const fresh = new Date(Date.now() + 1000); fs.utimesSync(path.join(root, compiled), fresh, fresh);
        write('dist/packages/web/stale.js', 'stale must never ship');
        // A fixture Vite CLI validates real child-process args/environment, then
        // generates a complete fresh tree. Production always executes installed Vite.
        write('node_modules/vite/bin/vite.js', `const fs=require('node:fs');const p=require('node:path');if(process.env.AP_BUILD_SOURCEMAP!=='false')throw new Error('maps enabled');if(process.argv.slice(2).join(' ')!=='build --config packages/web/vite.config.mts')throw new Error('wrong build command');fs.mkdirSync('dist/packages/web/assets',{recursive:true});fs.writeFileSync('dist/packages/web/index.html','<script src="/assets/fresh.js"></script>');fs.writeFileSync('dist/packages/web/assets/fresh.js',fs.readFileSync('${web}'));`);
        const pack = (includeWeb = true) => spawnSync(process.execPath, ['scripts/package-backend-patch.mjs', base, image, path.join(root, 'artifact'), ...(includeWeb ? ['--include-web'] : [])], { cwd: root, encoding: 'utf8' });
        run({ root, write, git, commit, pack });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const refused = (result, pattern) => { assert.notEqual(result.status, 0); assert.match(result.stderr, pattern); };

test('default backend-only packaging still rejects frontend changes', () => fixture(({ pack }) => refused(pack(false), /full image build/)));
test('opt-in builds fresh web assets and manifests every backend/web byte over the exact base', () => fixture(({ root, pack, git }) => {
    const result = pack(); assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'artifact/payload/backend-patch-manifest.json')));
    assert.equal(fs.statSync(path.join(root, 'artifact')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'artifact/payload/backend-patch-manifest.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(root, 'artifact/payload/dist/packages/web/index.html')).mode & 0o777, 0o600);
    assert.equal(manifest.kind, 'backend+web'); assert.equal(manifest.baseImage, image); assert.equal(manifest.sourceRevision, git('rev-parse', 'HEAD'));
    assert.deepEqual(manifest.files.map(entry => entry.compiled).sort(), [compiled, 'dist/packages/web/assets/fresh.js', 'dist/packages/web/index.html'].sort());
    for (const entry of manifest.files) assert.equal(entry.sha256, createHash('sha256').update(fs.readFileSync(path.join(root, 'artifact/payload', entry.compiled))).digest('hex'));
    assert.equal(fs.existsSync(path.join(root, 'artifact/payload/dist/packages/web/stale.js')), false);
    const docker = fs.readFileSync(path.join(root, 'artifact/Dockerfile'), 'utf8');
    assert.ok(docker.indexOf('RUN rm -rf dist/packages/web') < docker.indexOf('COPY payload/ ./'));
    assert.equal(git('status', '--porcelain'), '');
}));
test('dirty input fails before a web build can produce artifacts', () => fixture(({ write, pack, root }) => {
    write(web, 'uncommitted'); refused(pack(), /Commit and verify/);
    assert.equal(fs.existsSync(path.join(root, 'artifact')), false);
}));
for (const file of ['package.json', 'bun.lock', 'packages/web/vite.config.mts']) test(`dependency/build configuration change is refused: ${file}`, () => fixture(({ write, commit, pack }) => {
    write(file, 'changed'); commit(); refused(pack(), /full image build/);
}));
test('deleted frontend source requires a full image build', () => fixture(({ root, commit, pack }) => {
    fs.unlinkSync(path.join(root, web)); commit(); refused(pack(), /Deleted source/);
}));
test('stale backend emit is refused even when web mode is enabled', () => fixture(({ root, pack }) => {
    const old = new Date(0); fs.utimesSync(path.join(root, compiled), old, old); refused(pack(), /Compile current source/);
}));
test('compiled and generated web symlinks cannot enter a patch', () => {
    fixture(({ root, pack }) => { fs.unlinkSync(path.join(root, compiled)); fs.symlinkSync('/outside-runtime.js', path.join(root, compiled)); refused(pack(), /Symlink/); });
    fixture(({ write, pack }) => { write('node_modules/vite/bin/vite.js', `const fs=require('node:fs');fs.mkdirSync('dist/packages/web',{recursive:true});fs.writeFileSync('dist/packages/web/index.html','fresh');fs.symlinkSync('/outside-secret','dist/packages/web/leak.js');`); refused(pack(), /Symlink/); });
});
test('a web build that dirties committed source fails the post-build gate', () => fixture(({ write, pack }) => {
    write('node_modules/vite/bin/vite.js', `const fs=require('node:fs');fs.mkdirSync('dist/packages/web',{recursive:true});fs.writeFileSync('dist/packages/web/index.html','fresh');fs.writeFileSync('${web}','changed during build');`); refused(pack(), /source changed during packaging/);
}));
test('a web-only patch is allowed only with the explicit flag', () => fixture(({ write, commit, pack }) => {
    write(api, 'export const value = 1;\n'); commit();
    assert.equal(pack().status, 0);
}));
