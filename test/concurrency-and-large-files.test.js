import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,open} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createCommandAgent,executeCommand,outputLimit} from '../src/command-agent.js';
import {dispatchMcp,maxReadChunk} from '../src/agent-mcp.js';
import {discover} from '../src/file-discovery.js';
import {API_VERSION} from '../src/protocol-version.js';

const mac=process.platform==='darwin';
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-large-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
function freePort(){return new Promise(resolve=>{const server=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});}
function reader(dir){
  const config={deviceId:'test-device',deviceName:'test-device',cwd:dir,allowedPaths:[dir]};
  return async args=>(await dispatchMcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_file',arguments:{deviceId:'test-device',apiVersion:API_VERSION,...args}}},
    {protocolState:{apiVersion:API_VERSION,sourceVersion:API_VERSION,reloadRequired:false},getConfig:()=>config,execute:()=>{throw Error('unused');},runFileOperation:fn=>fn()})).result;
}

test('commands run concurrently instead of queueing behind a global lock',{skip:!mac},async t=>{
  const dir=await temporary(t),agent=await createCommandAgent({dataDir:dir});t.after(()=>agent.close());
  await agent.update({enabled:true,port:await freePort(),allowedPaths:[dir]});
  const started=Date.now();
  const runs=[1,2,3].map(()=>agent.exec({cmd:'sleep 1'}));
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(agent.view().activeOperations,3);
  const results=await Promise.all(runs);
  assert.ok(results.every(result=>result.ok));
  assert.ok(Date.now()-started<2500,'three 1s commands should overlap');
  assert.equal(agent.view().busy,false);
});

test('read_file chunks large files and never splits a UTF-8 character',async t=>{
  const dir=await temporary(t),read=reader(dir);
  await writeFile(path.join(dir,'text.txt'),'中文测试');
  const body=result=>{const text=result.content[0].text,split=text.indexOf('\n');return {header:text.slice(0,split),content:text.slice(split+1)};};
  const first=body(await read({path:'text.txt',maxBytes:4}));
  assert.equal(first.content,'中');assert.match(first.header,/bytes 0-3 of 12 \(more: offset=3\)$/);
  const rest=body(await read({path:'text.txt',offset:3}));
  assert.equal(rest.content,'文测试');assert.doesNotMatch(rest.header,/more:/);

  const big=path.join(dir,'big.bin'),handle=await open(big,'w');await handle.truncate(maxReadChunk+10);await handle.close();
  const chunk=body(await read({path:'big.bin',encoding:'base64',maxBytes:maxReadChunk*4}));
  assert.match(chunk.header,new RegExp(`bytes 0-${maxReadChunk} of ${maxReadChunk+10} base64 \\(more: offset=${maxReadChunk}\\)$`));
  const tail=body(await read({path:'big.bin',encoding:'base64',offset:maxReadChunk}));
  assert.match(tail.header,new RegExp(`bytes ${maxReadChunk}-${maxReadChunk+10} of ${maxReadChunk+10} base64$`));
});

test('FIFOs neither hang read_file nor content search',{skip:process.platform==='win32'},async t=>{
  const dir=await temporary(t),read=reader(dir);
  execFileSync('mkfifo',[path.join(dir,'pipe')]);await writeFile(path.join(dir,'note.txt'),'needle');
  const result=await read({path:'pipe'});assert.equal(result.isError,true);
  const found=await discover({cwd:dir,allowedPaths:[dir]},'content',{query:'needle'});
  assert.equal(found.results.length,1);
});

test('oversized command output is truncated with the full size reported',{skip:!mac},async t=>{
  const dir=await temporary(t),size=outputLimit+1000;
  const result=await executeCommand({cwd:dir,execBase64Enabled:0,pwshPath:'pwsh'},{cmd:`head -c ${size} /dev/zero`});
  assert.equal(result.ok,true);assert.equal(result.truncated,true);
  assert.equal(result.stdoutBytes,size);assert.equal(result.stdout.length,outputLimit);
});
