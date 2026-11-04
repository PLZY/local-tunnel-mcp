import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {generateKeyPairSync} from 'node:crypto';
import ssh2 from 'ssh2';
import {createConsole} from '../src/server.js';

test('first-use trust protects credentials, persists, supports OpenSSH keys and detects changed host keys',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'tunnel trust '));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const privateKey=()=>generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
  let authAttempts=0,sshServer,app;const clients=new Set();
  async function listen(port=0){
    sshServer=new ssh2.Server({hostKeys:[privateKey()]},client=>{
      clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
      client.on('authentication',ctx=>{authAttempts++;if(ctx.method==='publickey'||ctx.method==='password'&&ctx.password==='secret')ctx.accept();else ctx.reject();});
      client.on('request',(accept,reject,name)=>{if(name==='tcpip-forward')accept();else reject();});
    });
    await new Promise(resolve=>sshServer.listen(port,'127.0.0.1',resolve));return sshServer.address().port;
  }
  async function closeSsh(){for(const client of clients)client.end();await new Promise(resolve=>sshServer.close(resolve));}
  t.after(async()=>{await app?.close();await closeSsh();});
  const port=await listen();app=await createConsole({directory:dir,port:0});
  let headers;
  async function session(){headers={'X-Local-Console':'1'};const {csrf}=await (await fetch(app.url+'/api/session',{headers})).json();Object.assign(headers,{'Content-Type':'application/json','X-CSRF-Token':csrf});}
  await session();
  async function call(route,body,status=200){const response=await fetch(app.url+route,{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,status);return response.json();}
  const settings={sshHost:'127.0.0.1',sshPort:port,sshUser:'tester',identityFile:'',authMethod:'password',password:'secret'};
  const first=await call('/api/test-ssh',settings);
  assert.equal(first.ok,false);assert.ok(first.hostTrust.challenge);assert.equal(first.hostTrust.changed,false);
  assert.equal(first.hostTrust.key,undefined);assert.equal(authAttempts,0);
  await call('/api/trust-ssh',{challenge:'forged'},400);assert.equal(authAttempts,0);
  await call('/api/trust-ssh',{challenge:first.hostTrust.challenge});
  assert.equal((await call('/api/test-ssh',settings)).ok,true);assert.ok(authAttempts>0);
  // Seed the legacy default-port entry to verify regeneration after restart.
  const trustFile=path.join(dir,'ssh-trust.json');
  const trusted=JSON.parse(await readFile(trustFile,'utf8'));
  trusted['127.0.0.1:22']=trusted[`127.0.0.1:${port}`];
  await writeFile(trustFile,JSON.stringify(trusted));
  await app.close();app=await createConsole({directory:dir,port:0});await session();
  assert.equal((await call('/api/ssh-host',settings)).trusted,true);
  const knownHostsFile=path.join(dir,'known_hosts');
  for(const host of ['127.0.0.1',`[127.0.0.1]:${port}`]){
    const {stdout}=await promisify(execFile)('ssh-keygen',['-F',host,'-f',knownHostsFile]);
    assert.ok(stdout.includes(' found: '),`OpenSSH must find ${host}`);
  }
  assert.ok(!(await readFile(knownHostsFile,'utf8')).includes('[127.0.0.1]:22 '));
  assert.equal((await call('/api/test-ssh',settings)).ok,true);
  // The same approved host key is used by OpenSSH; no terminal trust command is needed.
  const identityFile=path.join(dir,'test-key');await writeFile(identityFile,privateKey(),{mode:0o600});
  if(process.platform==='win32')await promisify(execFile)('icacls',[identityFile,'/inheritance:r','/grant:r',os.userInfo().username+':(F)']);
  const keyResult=await call('/api/test-ssh',{...settings,authMethod:'key',identityFile});
  assert.equal(keyResult.ok,true,keyResult.message);
  const original=first.hostTrust.fingerprint;const before=authAttempts;
  await closeSsh();await listen(port);
  const changed=await call('/api/test-ssh',settings);
  assert.equal(changed.ok,false);assert.equal(changed.hostTrust.changed,true);
  assert.equal(changed.hostTrust.previousFingerprint,original);assert.notEqual(changed.hostTrust.fingerprint,original);
  assert.equal(authAttempts,before);
  await call('/api/trust-ssh',{challenge:changed.hostTrust.challenge});
  assert.equal((await call('/api/test-ssh',settings)).ok,true);
  const {id}=await call('/api/connections',{action:'create',name:'自动连接'});
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const localPort=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const put=await fetch(app.url+'/api/agent?connection='+id,{method:'PUT',headers,body:JSON.stringify({...settings,enabled:true,tunnelEnabled:true,port:localPort,allowedPaths:[dir]})});
  assert.equal(put.status,200);
  let view;
  for(let i=0;i<100;i++){view=await (await fetch(app.url+'/api/agent?connection='+id,{headers})).json();if(view.hostTrust)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(view.tunnel.state,'trust-required');assert.ok(view.hostTrust.challenge);
  const attemptsBeforeTrust=authAttempts;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(authAttempts,attemptsBeforeTrust);
  await call('/api/trust-ssh?connection='+id,{challenge:view.hostTrust.challenge});
  for(let i=0;i<100;i++){view=await (await fetch(app.url+'/api/agent?connection='+id,{headers})).json();if(view.tunnel.state==='connected')break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(view.tunnel.state,'connected');
});
