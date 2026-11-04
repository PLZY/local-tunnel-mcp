import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,access,readFile,writeFile,cp,appendFile,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createCommandAgent} from '../src/command-agent.js';
import {API_VERSION,fingerprintSources,fingerprintDirectory,contractVersion} from '../src/protocol-version.js';

async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-version-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
async function fixture(t){
  const dir=await temporary(t),agent=await createCommandAgent({dataDir:path.join(dir,'state')});t.after(()=>agent.close());
  await agent.update({enabled:true,port:await freePort(),deviceId:'version-test',allowedPaths:[dir]});
  const headers={Authorization:'Bearer '+agent.token(),'X-Device-Id':'version-test','Content-Type':'application/json'};
  async function rpc(method,params={}){return (await (await fetch(agent.view().localUrl+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json());}
  return {dir,agent,headers,rpc,url:agent.view().localUrl};
}

test('fingerprint is deterministic and covers implementation changes, while normalizing checkout line endings',()=>{
  const first=[['b.js','function read() { return 1; }\n'],['a.js','export const v=1;\n']];
  assert.equal(fingerprintSources(first),fingerprintSources([...first].reverse()));
  assert.equal(fingerprintSources(first),fingerprintSources(first.map(([name,source])=>[name,source.replaceAll('\n','\r\n')])));
  assert.notEqual(fingerprintSources(first),fingerprintSources([first[0],['a.js','export const v=2;\n']]));
  assert.notEqual(fingerprintSources(first),fingerprintSources([...first,['new-method.js','export function search() {}']]));
  assert.match(API_VERSION,/^[a-f0-9]{16}$/);
});
test('contract version ignores key order and implementation, and changes with any tool definition',()=>{
  const contract={tools:[{name:'a',description:'x',inputSchema:{type:'object',properties:{}}}],instructions:'i'};
  assert.equal(contractVersion(contract),contractVersion({instructions:'i',tools:[{inputSchema:{properties:{},type:'object'},description:'x',name:'a'}]}));
  assert.notEqual(contractVersion(contract),contractVersion({...contract,instructions:'j'}));
  assert.notEqual(contractVersion(contract),contractVersion({...contract,tools:[{...contract.tools[0],description:'y'}]}));
});
test('mutating tools require the current version, read tools reject a stale one, and the error text says how to recover',async t=>{
  const f=await fixture(t),listed=await f.rpc('tools/list');assert.equal(listed.result._meta.apiVersion,API_VERSION);
  const mutating=new Set(['edit_file','write_file',process.platform==='win32'?'execute_powershell':'execute_shell']);
  for(const tool of listed.result.tools){
    assert.equal(tool.inputSchema.required.includes('apiVersion'),mutating.has(tool.name),tool.name);
    assert.equal(tool.inputSchema.properties.apiVersion.enum,undefined);
    assert.equal(tool.inputSchema.properties.apiVersion.description.includes(API_VERSION),mutating.has(tool.name),tool.name);
    for(const version of mutating.has(tool.name)?[undefined,'sha256:obsolete']:['sha256:obsolete']){
      const result=(await f.rpc('tools/call',{name:tool.name,arguments:{deviceId:'version-test',...(version?{apiVersion:version}:{})}})).result;
      assert.equal(result.isError,true);assert.equal(result.structuredContent,undefined);
      assert.ok(result.content[0].text.startsWith('接口版本过旧，请重新拉取. The call was NOT executed. Current apiVersion: '+API_VERSION));
    }
  }
  const unversioned=(await f.rpc('tools/call',{name:'get_local_info',arguments:{deviceId:'version-test'}})).result;assert.equal(unversioned.isError,false);
  const info=JSON.parse(unversioned.content[0].text);assert.equal(info.apiVersion,API_VERSION);assert.equal(info.reloadRequired,false);
  const removed=await f.rpc('tools/call',{name:'get_api_version',arguments:{deviceId:'version-test'}});assert.match(removed.error.message,/Reload tools\/list/);
  const oldRemoved=(await f.rpc('tools/call',{name:'an_old_removed_tool',arguments:{deviceId:'version-test',apiVersion:'old'}})).result;assert.match(oldRemoved.content[0].text,/NOT executed/);
  const resource=await f.rpc('resources/read',{uri:'local-tunnel://workspace',_meta:{apiVersion:'old'}});assert.equal(resource.error.data.code,'API_VERSION_MISMATCH');
  const resourceOK=await f.rpc('resources/read',{uri:'local-tunnel://workspace',_meta:{apiVersion:API_VERSION}});assert.ok(resourceOK.result.contents);
  const resourceUnversioned=await f.rpc('resources/read',{uri:'local-tunnel://workspace'});assert.ok(resourceUnversioned.result.contents);
  for(const endpoint of ['/health','/config']){
    const stale=await fetch(f.url+endpoint,{headers:f.headers});assert.equal(stale.status,409);assert.equal((await stale.json()).requestExecuted,false);
    const current=await fetch(f.url+endpoint,{headers:{...f.headers,'X-API-Version':API_VERSION}});assert.equal(current.status,200);assert.equal(current.headers.get('X-API-Version'),API_VERSION);
  }
  assert.equal((await (await fetch(f.url+'/version',{headers:f.headers})).json()).apiVersion,API_VERSION);
});
test('outdated mutation requests cannot execute through MCP or legacy HTTP',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),cmd='printf new-version > marker.txt',marker=path.join(f.dir,'marker.txt');
  const args={deviceId:'version-test',cmd};
  for(const apiVersion of [undefined,'old']){
    const request={...args,...(apiVersion===undefined?{}:{apiVersion})};
    const result=(await f.rpc('tools/call',{name:'execute_shell',arguments:request})).result;
    assert.equal(result.isError,true);assert.equal(result.structuredContent,undefined);
    assert.ok(result.content[0].text.includes('The call was NOT executed. Current apiVersion: '+API_VERSION));
    await assert.rejects(access(marker),{code:'ENOENT'});assert.equal(f.agent.view().lastResult,null);
    const legacy=await fetch(f.url+'/exec',{method:'POST',headers:f.headers,body:JSON.stringify(request)});
    assert.equal(legacy.status,409);
    const failure=await legacy.json();
    assert.equal(failure.code,'API_VERSION_MISMATCH');assert.equal(failure.requestExecuted,false);assert.equal(failure.currentApiVersion,API_VERSION);
    await assert.rejects(access(marker),{code:'ENOENT'});assert.equal(f.agent.view().lastResult,null);
  }
  const valid=(await f.rpc('tools/call',{name:'execute_shell',arguments:{...args,apiVersion:API_VERSION}})).result;
  assert.equal(valid.isError,false);assert.equal(valid.structuredContent,undefined);assert.match(valid.content[0].text,/^exit 0,/);
  assert.equal(await readFile(marker,'utf8'),'new-version');
});

test('implementation edits never block a running server; a contract change bumps the version after restart',async t=>{
  const dir=await temporary(t),source=path.join(dir,'src'),data=path.join(dir,'state'),port=await freePort();
  await cp(fileURLToPath(new URL('../src/',import.meta.url)),source,{recursive:true});await writeFile(path.join(dir,'package.json'),'{"type":"module"}');
  await symlink(fileURLToPath(new URL('../node_modules/',import.meta.url)),path.join(dir,'node_modules'),process.platform==='win32'?'junction':'dir');
  let child;
  async function stop(){if(!child||child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('close',resolve));child.kill('SIGTERM');await exited;}
  t.after(stop);
  async function launch(){
    const script=`const {createCommandAgent}=await import(process.argv[1]);const {API_VERSION}=await import(process.argv[2]);const a=await createCommandAgent({dataDir:process.argv[3]});await a.update({enabled:true,deviceId:'version-test',port:Number(process.argv[4]),allowedPaths:[process.argv[5]]});process.once('SIGTERM',()=>void a.close());console.log(JSON.stringify({url:a.view().localUrl,token:a.token(),apiVersion:API_VERSION}));`;
    child=spawn(process.execPath,['--input-type=module','-e',script,pathToFileURL(path.join(source,'command-agent.js')).href,pathToFileURL(path.join(source,'protocol-version.js')).href,data,String(port),dir],{stdio:['ignore','pipe','pipe']});
    return new Promise((resolve,reject)=>{
      let output='',errors='';const timer=setTimeout(()=>reject(Error('Test server startup timeout')),10000);
      child.stderr.on('data',chunk=>{errors+=chunk;});child.once('close',code=>{clearTimeout(timer);reject(Error(`Test server exited ${code}: ${errors}`));});
      child.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]));}});
    });
  }
  const first=await launch();
  async function rpc(server,name,args){return (await (await fetch(server.url+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+server.token,'X-Device-Id':'version-test','Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{deviceId:'version-test',...args}}})})).json()).result;}
  assert.equal((await rpc(first,'get_local_info',{apiVersion:first.apiVersion})).isError,false);
  await appendFile(path.join(source,'file-discovery.js'),'\n// Simulate an implementation update.\n');
  const stillWorking=await rpc(first,'get_local_info',{apiVersion:first.apiVersion});assert.equal(stillWorking.isError,false);
  const pending=JSON.parse((await rpc(first,'get_local_info',{})).content[0].text);assert.equal(pending.reloadRequired,true);assert.equal(pending.apiVersion,first.apiVersion);
  await stop();const second=await launch();assert.equal(second.apiVersion,first.apiVersion);assert.equal(second.token,first.token);
  const mcpFile=path.join(source,'agent-mcp.js');
  await writeFile(mcpFile,(await readFile(mcpFile,'utf8')).replace('Indented listing of a LOCAL directory','An indented listing of a LOCAL directory'));
  await stop();const next=await launch();assert.notEqual(next.apiVersion,first.apiVersion);
  const stale=await rpc(next,'get_local_info',{apiVersion:first.apiVersion});assert.equal(stale.isError,true);assert.ok(stale.content[0].text.includes('Current apiVersion: '+next.apiVersion));
  const refreshed=JSON.parse((await rpc(next,'get_local_info',{})).content[0].text);assert.equal(refreshed.reloadRequired,false);assert.equal(refreshed.apiVersion,next.apiVersion);
  const result=await rpc(next,'get_local_info',{apiVersion:refreshed.apiVersion});assert.equal(result.isError,false);
});