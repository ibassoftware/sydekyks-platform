import fs from 'node:fs';
import ts from 'typescript';
const build = ts.parseConfigFileTextToJson('bun.lock',fs.readFileSync('bun.lock','utf8')).config;
const runtime = ts.parseConfigFileTextToJson('runtime/bun.lock',fs.readFileSync('runtime/bun.lock','utf8')).config;
const buildResolutions = new Set(Object.values(build.packages).map(record => JSON.stringify([record[0], record.at(-1)])));
for (const [name, record] of Object.entries(runtime.packages)) {
    if (name === 'ee-embed-sdk' || name.startsWith('@activepieces/ee')) throw new Error('Restricted installed dependency: '+name);
    if (record[0].includes('workspace:')) continue;
    if (!buildResolutions.has(JSON.stringify([record[0], record.at(-1)]))) throw new Error('Runtime resolution differs from frozen build: '+name);
}
console.log(JSON.stringify({runtimeVersionsAndIntegrityMatchBuild:true,packages:Object.keys(runtime.packages).length}));
