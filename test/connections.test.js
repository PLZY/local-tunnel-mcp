import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {generateKeyPairSync,createHash} from 'node:crypto';
import ssh2 from 'ssh2';
const {Server,utils}=ssh2;
import {createConnections} from '../src/connections.js';
import {createConsole} from '../src/server.js';
import {testSshConnection} from '../src/ssh-connection.js';

test('profiles persist independently, run simultaneously and delete without stopping siblings',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tunnel-profiles-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  let manager=await createConnections(dir);t.after(()=>manager.close());
  const a=await manager.change({action:'create',name:'服务器 A'}),b=await manager.change({action:'create',name:'服务器 B'});
  const ports=manager.list().map(x=>x.config.port);assert.equal(new Set(ports).size,3);
  await manager.get(a).update({enabled:true,allowedPaths:[dir],password:'secret',authMethod:'password'});
  await manager.get(b).update({enabled:true,allowedPaths:[dir]});
  assert.equal(manager.get(a).view().listening,true);assert.equal(manager.get(b).view().listening,true);
  assert.equal(manager.get(a).view().config.password,undefined);
  assert.equal(manager.get(a).view().config.passwordConfigured,true);
  await manager.get(a).update({password:''});assert.equal(manager.get(a).sshSettings({}).password,'secret');
  await manager.close();manager=await createConnections(dir);
  assert.equal(manager.get(a).view().listening,true);assert.equal(manager.get(b).view().listening,true);
  await manager.change({action:'delete',id:a});assert.equal(manager.get(b).view().listening,true);
  assert.throws(()=>manager.get(a),/不存在/);
});

test('real SSH password auth, fingerprint rejection and reverse forwarding',async t=>{
  // ssh2 accepts OpenSSH/RSA PEM keys on all supported Node versions.
  const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
  const fingerprint='SHA256:'+createHash('sha256').update(utils.parseKey(rsa).getPublicSSH()).digest('base64').replace(/=+$/,'');
  const clients=new Set();let forward;
  const server=new Server({hostKeys:[rsa]},client=>{
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    client.on('authentication',ctx=>ctx.method==='password'&&ctx.username==='tester'&&ctx.password===' secret '?ctx.accept():ctx.reject());
    client.on('request',(accept,reject,name,info)=>{if(name==='tcpip-forward'){forward={client,info};accept();}else reject();});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const c of clients)c.end();server.close();});
  const settings={sshHost:'127.0.0.1',sshPort:server.address().port,sshUser:'tester',identityFile:'',authMethod:'password',password:' secret ',hostFingerprint:fingerprint};
  assert.equal((await testSshConnection(settings)).ok,true);
  assert.equal((await testSshConnection({...settings,password:'bad'})).ok,false);
  assert.equal((await testSshConnection({...settings,hostFingerprint:'SHA256:'+'A'.repeat(43)})).ok,false);
  const dir=await mkdtemp(path.join(os.tmpdir(),'tunnel-password-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const manager=await createConnections(dir);t.after(()=>manager.close());
  // Reserve then release a local port for the HTTP command listener.
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  await manager.get().update({...settings,port,remotePort:19095,enabled:true,tunnelEnabled:true,allowedPaths:[dir]});
  for(let i=0;i<100&&!forward;i++)await new Promise(r=>setTimeout(r,20));
  assert.ok(forward);assert.equal(forward.info.bindAddr,'127.0.0.1');
  const response=await new Promise((resolve,reject)=>forward.client.forwardOut('127.0.0.1',19095,'127.0.0.1',12345,(err,stream)=>{
    if(err)return reject(err);let text='';stream.on('data',chunk=>text+=chunk);stream.on('end',()=>resolve(text));stream.on('error',reject);stream.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  }));
  assert.match(response,/403/);
  const second=await manager.change({action:'create',name:'第二台服务器'});
  await new Promise(r=>probe.listen(0,'127.0.0.1',r));const secondPort=probe.address().port;await new Promise(r=>probe.close(r));
  await manager.get(second).update({...settings,port:secondPort,remotePort:19096,enabled:true,tunnelEnabled:true,allowedPaths:[dir]});
  for(let i=0;i<100&&manager.get(second).view().tunnel.state!=='connected';i++)await new Promise(r=>setTimeout(r,20));
  assert.equal(manager.get().view().tunnel.state,'connected');
  assert.equal(manager.get(second).view().tunnel.state,'connected');
  await manager.get().update({enabled:false,tunnelEnabled:false});
  assert.equal(manager.get().view().tunnel.state,'disabled');
  assert.equal(manager.get(second).view().tunnel.state,'connected');
  assert.equal(manager.get(second).view().listening,true);
});


test('console operations and MCP copies use only the selected connection',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tunnel-tabs-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const app=await createConsole({directory:dir,port:0});t.after(()=>app.close());
  const headers={'X-Local-Console':'1'};
  const {csrf}=await (await fetch(app.url+'/api/session',{headers})).json();
  Object.assign(headers,{'Content-Type':'application/json','X-CSRF-Token':csrf});
  async function call(route,method='GET',body){
    const response=await fetch(app.url+route,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
    assert.equal(response.status,200);return response.json();
  }
  const {id:a}=await call('/api/connections','POST',{action:'create',name:'服务器 A'});
  const {id:b}=await call('/api/connections','POST',{action:'create',name:'服务器 B'});
  await call('/api/agent?connection='+a,'PUT',{enabled:true,allowedPaths:[dir],remotePort:21001});
  await call('/api/agent?connection='+b,'PUT',{enabled:true,allowedPaths:[dir],remotePort:21002});
  const first=JSON.parse((await call('/api/integrations?connection='+a,'POST',{})).generic);
  const second=JSON.parse((await call('/api/integrations?connection='+b,'POST',{})).generic);
  const entryA=Object.values(first.mcpServers)[0],entryB=Object.values(second.mcpServers)[0];
  assert.match(entryA.url,/:21001\/mcp$/);assert.match(entryB.url,/:21002\/mcp$/);
  assert.notEqual(entryA.headers.Authorization,entryB.headers.Authorization);
  await call('/api/agent?connection='+a,'PUT',{enabled:false,tunnelEnabled:false});
  assert.equal((await call('/api/agent?connection='+a)).listening,false);
  assert.equal((await call('/api/agent?connection='+b)).listening,true);
});
