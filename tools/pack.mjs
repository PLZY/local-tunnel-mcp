// Assembles dist/<target>/app: the program, its production dependencies and the official Node runtime.
// Usage: node tools/pack.mjs win-x64|darwin-arm64|darwin-x64
// The runtime matches the Node version running this script. All dependencies are plain JavaScript,
// so any machine can build any target.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const target=process.argv[2];
const formats={'win-x64':'zip','darwin-arm64':'tar.gz','darwin-x64':'tar.gz'};
if(!formats[target])throw Error(`Unknown target: ${target}`);
const windows=target==='win-x64';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=path.join(root,'dist',target),app=path.join(output,'app');
const name=`node-${process.version}-${target}`,archive=`${name}.${formats[target]}`,base=`https://nodejs.org/dist/${process.version}/`;

async function download(url) {
  const response=await fetch(url);
  if(!response.ok)throw Error(`Download failed: ${url} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

await rm(output,{recursive:true,force:true});
await mkdir(path.join(app,'runtime'),{recursive:true});
for(const entry of ['src','public','package.json','package-lock.json','LICENSE'])await cp(path.join(root,entry),path.join(app,entry),{recursive:true});
execFileSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund',{cwd:app,shell:true,stdio:'inherit'});
await rm(path.join(app,'package-lock.json'));

const data=await download(base+archive);
const sums=(await download(base+'SHASUMS256.txt')).toString();
const expected=sums.split('\n').find(line=>line.endsWith(`  ${archive}`))?.split(' ')[0];
if(!expected||createHash('sha256').update(data).digest('hex')!==expected)throw Error(`Checksum mismatch: ${archive}`);
await writeFile(path.join(output,archive),data);
const member=windows?`${name}/node.exe`:`${name}/bin/node`;
execFileSync('tar',['-xf',archive,member],{cwd:output,stdio:'inherit'});
await cp(path.join(output,member),path.join(app,'runtime',path.basename(member)));
await rm(path.join(output,archive));
await rm(path.join(output,name),{recursive:true});
console.log(`Packed ${target} with Node ${process.version}: ${app}`);
