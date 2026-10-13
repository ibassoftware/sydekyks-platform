import fs from 'node:fs';
import path from 'node:path';

const destination = path.resolve('runtime');
fs.rmSync(destination, {recursive:true, force:true});
fs.mkdirSync(destination, {recursive:true});
const sourcePackage = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const workspaces = [];
function copy(source, target) {
    if (!fs.existsSync(source)) return;
    fs.mkdirSync(path.dirname(target), {recursive:true});
    fs.cpSync(source, target, {recursive:true, filter:file => !file.endsWith('.map') && !file.endsWith('.d.ts') && !file.endsWith('.tsbuildinfo')});
}
function walk(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
        if (['node_modules', 'dist', 'src', 'test', 'tests'].includes(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full);
    }
    const manifest = path.join(directory, 'package.json');
    if (!fs.existsSync(manifest) || !fs.existsSync(path.join(directory,'dist'))) return;
    if (directory.startsWith('packages/ee') || directory.startsWith('packages/web')) throw new Error('Restricted runtime workspace');
    const packageJson = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const installed = {...packageJson, scripts:{}, devDependencies:{}};
    fs.mkdirSync(path.join(destination,directory), {recursive:true});
    fs.writeFileSync(path.join(destination,manifest), JSON.stringify(installed,null,2)+'\n');
    copy(path.join(directory,'dist'), path.join(destination,directory,'dist'));
    for (const notice of ['LICENSE','LICENSE.md','LICENSE.txt','NOTICE','NOTICE.txt']) copy(path.join(directory,notice), path.join(destination,directory,notice));
    workspaces.push(directory);
}
walk('packages');
if (!workspaces.includes('packages/server/engine')) {
    const manifest='packages/server/engine/package.json';
    const pkg=JSON.parse(fs.readFileSync(manifest,'utf8'));
    fs.mkdirSync(path.join(destination,'packages/server/engine'),{recursive:true});
    fs.writeFileSync(path.join(destination,manifest),JSON.stringify({...pkg,scripts:{},devDependencies:{}},null,2)+'\n');
    workspaces.push('packages/server/engine');
}
for (const directory of ['dist/packages/engine','dist/packages/web','packages/server/api/src/assets']) copy(directory,path.join(destination,directory));
fs.copyFileSync('dist/packages/engine/main.js.map', path.join(destination,'dist/packages/engine/main.js.map'));
const rootPackage={name:'sydekyks',version:sourcePackage.version,private:true,workspaces,dependencies:sourcePackage.dependencies,trustedDependencies:['isolated-vm','sqlite3'],scripts:{}};
fs.writeFileSync(path.join(destination,'package.json'),JSON.stringify(rootPackage,null,2)+'\n');
for (const file of ['LICENSE','NOTICE.sydekyks.txt','docker-entrypoint.sh','bun.lock']) copy(file,path.join(destination,file));
const manifest={publicVersion:'1.0.6',version:sourcePackage.version,permittedWorkspaces:workspaces.sort(),upstreamNotice:'LICENSE',applicationEdition:'ce',distributionPolicy:'free software; no activation, trial or license required',databaseSupport:['fresh PostgreSQL installations','released Sydekyks 1.0.x upgrades after backup'],restrictedRootsRemoved:['packages/ee','packages/server/api/src/app/ee']};
fs.writeFileSync(path.join(destination,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({stagedWorkspaces:workspaces.length}));
