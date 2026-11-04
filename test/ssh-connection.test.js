import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {testSshConnection} from '../src/ssh-connection.js';
import {createConsole} from '../src/server.js';
import {createCommandAgent} from '../src/command-agent.js';

const settings={sshHost:'example.com',sshUser:'tester',sshPort:22,identityFile:''};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fakeSpawn(output,{children=[],exit=true}={}){
  return (binary,args)=>{
    assert.equal(binary,'ssh');const child=new EventEmitter();child.stderr=new PassThrough();child.args=args;child.killed=false;
    child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('close',null));};children.push(child);
    queueMicrotask(()=>{child.stderr.write(output);if(exit)child.emit('close',255);});return child;
  };
}
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-ssh-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('SSH test authenticates without forwarding or commands and terminates its own child',async()=>{
  const children=[];
  const result=await testSshConnection(settings,{spawnSsh:fakeSpawn('Authenticated to example.com ([127.0.0.1]:22) using "publickey".',{children,exit:false})});
  assert.equal(result.ok,true);assert.equal(children[0].killed,true);
  const args=children[0].args;assert.ok(args.includes('-N'));assert.ok(args.includes('ClearAllForwardings=yes'));assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('UpdateHostKeys=no'));assert.ok(!args.includes('-R'));assert.equal(args.at(-1),'tester@example.com');
});
test('SSH test diagnoses key, host trust and network failures',async()=>{
  for(const [log,message] of [['Permission denied (publickey).',/认证失败/],['Host key verification failed.',/指纹/],['Connection refused',/拒绝连接/],['Could not resolve hostname badhost',/解析/],['WARNING: UNPROTECTED PRIVATE KEY FILE!',/权限/],['Load key "key": invalid format',/格式/]]){
    const result=await testSshConnection(settings,{spawnSsh:fakeSpawn(log)});assert.equal(result.ok,false);assert.match(result.message,message);
  }
  let spawned=false;
  await assert.rejects(testSshConnection({...settings,identityFile:path.join(os.tmpdir(),'nonexistent-local-tunnel-key-9348')},{spawnSsh:()=>{spawned=true;}}),/私钥文件不存在/);assert.equal(spawned,false);
  await assert.rejects(testSshConnection({...settings,sshHost:'-oProxyCommand=bad'}),/地址/);
  await assert.rejects(testSshConnection({...settings,sshUser:''}),/登录用户/);
});
test('SSH test handles timeout, abort and missing client, without leaving children',async()=>{
  const children=[];
  const timeout=await testSshConnection(settings,{spawnSsh:fakeSpawn('',{children,exit:false}),timeoutMs:20});assert.equal(timeout.ok,false);assert.match(timeout.message,/超时/);assert.equal(children[0].killed,true);
  const controller=new AbortController();
  const pending=testSshConnection(settings,{spawnSsh:fakeSpawn('',{children,exit:false}),signal:controller.signal});await tick();controller.abort();
  assert.match((await pending).message,/取消/);assert.equal(children[1].killed,true);
  const missing=await testSshConnection(settings,{spawnSsh:()=>{const child=new EventEmitter();child.stderr=new PassThrough();queueMicrotask(()=>child.emit('error',Object.assign(new Error('missing'),{code:'ENOENT'})));return child;}});
  assert.equal(missing.ok,false);assert.match(missing.message,/找不到 ssh/);
});
test('connection-test endpoint protects sessions, accepts unsaved SSH fields and preserves config',async t=>{
  const dir=await temporary(t);let received,release;
  const app=await createConsole({directory:dir,port:0,sshTester:input=>{received=input;return new Promise(resolve=>{release=resolve;});}});t.after(()=>app.close());
  const before=await readFile(path.join(dir,'command-agent.json'),'utf8');
  assert.equal((await fetch(app.url+'/api/test-ssh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)})).status,403);
  const headers={'X-Local-Console':'1'};const {csrf}=await (await fetch(app.url+'/api/session',{headers})).json();
  Object.assign(headers,{'Content-Type':'application/json','X-CSRF-Token':csrf});
  const pending=fetch(app.url+'/api/test-ssh',{method:'POST',headers,body:JSON.stringify({...settings,sshPort:2222})});
  for(let i=0;!release&&i<100;i++)await tick();assert.ok(release);assert.equal(received.sshPort,2222);
  const duplicate=await fetch(app.url+'/api/test-ssh',{method:'POST',headers,body:JSON.stringify(settings)});assert.equal(duplicate.status,409);
  release({ok:true,message:'SSH 连接成功',durationMs:1});assert.equal((await (await pending).json()).ok,true);
  assert.equal(await readFile(path.join(dir,'command-agent.json'),'utf8'),before);
});
test('device display defaults to ID and follows renames, while custom labels survive',async t=>{
  const dir=await temporary(t),agent=await createCommandAgent({dataDir:dir});t.after(()=>agent.close());
  assert.equal(agent.view().config.deviceName,agent.view().config.deviceId);
  await agent.update({deviceId:'office-mac'});assert.equal(agent.view().config.deviceName,'office-mac');
  await agent.update({deviceName:'办公室'});await agent.update({deviceId:'work-mac'});assert.equal(agent.view().config.deviceName,'办公室');
});
