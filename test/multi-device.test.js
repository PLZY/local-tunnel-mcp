import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createCommandAgent} from '../src/command-agent.js';
import {connectionBundle} from '../src/integrations.js';
import {newDeviceIdentity,migrateDeviceIdentity} from '../src/device-identity.js';

async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-devices-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
function fakeSsh(children){return (binary,args)=>{
  assert.equal(binary,'ssh');const child=new EventEmitter();child.args=args;child.stderr=new PassThrough();
  child.kill=()=>queueMicrotask(()=>child.emit('close',0));children.push(child);return child;
};}

test('default ID is the machine hostname, tokens are independent, and custom names persist',async t=>{
  const dir=await temporary(t);
  let first=await createCommandAgent({dataDir:path.join(dir,'first')});const second=await createCommandAgent({dataDir:path.join(dir,'second')});
  t.after(()=>first.close());t.after(()=>second.close());
  const originalId=first.view().config.deviceId,token=first.token();
  assert.equal(originalId,newDeviceIdentity().deviceId);assert.equal(originalId,second.view().config.deviceId);assert.notEqual(token,second.token());
  assert.match(originalId,/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
  // Ports are explicitly allocated by the user, not silently chosen or stolen.
  assert.equal(first.view().config.remotePort,19095);assert.equal(second.view().config.remotePort,19095);
  for(const deviceId of ['','bad.name','a\ninvalid','--bad','bad/name','x'.repeat(65)])await assert.rejects(first.update({deviceId}),/MCP/);
  for(const deviceName of ['','\n','a\nb','x'.repeat(81)])await assert.rejects(first.update({deviceName}),/设备名称/);
  assert.equal(first.view().config.deviceId,originalId);
  await first.update({deviceId:'office-mac',deviceName:' 办公室 Mac ',remotePort:19096});
  assert.equal(first.view().config.deviceName,'办公室 Mac');assert.equal(first.token(),token);
  await first.close();first=await createCommandAgent({dataDir:path.join(dir,'first')});
  assert.equal(first.view().config.deviceId,'office-mac');assert.equal(first.view().config.remotePort,19096);assert.equal(first.token(),token);
});

test('legacy generic name upgrades to hostname while ports, enabled flags and token survive',async t=>{
  const dir=await temporary(t),original=await createCommandAgent({dataDir:dir});const token=original.token();await original.close();
  const file=path.join(dir,'command-agent.json'),saved=JSON.parse(await readFile(file,'utf8'));
  saved.deviceId='local-computer';saved.deviceName='local-computer';
  Object.assign(saved,{remotePort:29123,enabled:true,tunnelEnabled:true,sshHost:'example.com',sshUser:'tester',port:await freePort(),cwd:dir,allowedPaths:[dir]});
  await writeFile(file,JSON.stringify(saved));
  const children=[],migrated=await createCommandAgent({dataDir:dir,spawnSsh:fakeSsh(children)});t.after(()=>migrated.close());
  const machine=newDeviceIdentity().deviceId;
  assert.equal(migrated.view().config.deviceId,machine);assert.equal(migrated.view().config.deviceName,machine);
  assert.equal(migrated.view().config.remotePort,29123);assert.equal(migrated.view().config.enabled,true);assert.equal(migrated.view().config.tunnelEnabled,true);assert.equal(migrated.view().listening,true);assert.equal(children.length,1);assert.equal(migrated.token(),token);
  const bundle=connectionBundle(migrated.view(),migrated.token());assert.ok(JSON.parse(bundle.generic).mcpServers[machine]);
  assert.equal(JSON.parse(await readFile(file,'utf8')).deviceId,machine);
});

test('machine name keeps its spelling without prefixes or random suffixes; custom IDs are untouched',()=>{
  assert.deepEqual(newDeviceIdentity('My-Mac-mini.local'),{deviceId:'My-Mac-mini',deviceName:'My-Mac-mini'});
  assert.deepEqual(newDeviceIdentity('DESKTOP-123'),{deviceId:'DESKTOP-123',deviceName:'DESKTOP-123'});
  assert.equal(migrateDeviceIdentity({}).deviceId,newDeviceIdentity().deviceId);
  assert.deepEqual(migrateDeviceIdentity({deviceId:'office-mac',deviceName:'办公室'}),{deviceId:'office-mac',deviceName:'办公室'});
});

test('two simultaneous MCP clients identify devices and read files from the correct roots',async t=>{
  const dir=await temporary(t),children=[],agents=[],clients=[];
  const specs=[{deviceId:'office-mac',deviceName:'办公室 Mac',remotePort:19095},{deviceId:'home-mac',deviceName:'家里的 Mac',remotePort:19096}];
  t.after(async()=>{await Promise.all(clients.map(c=>c.close()));await Promise.all(agents.map(a=>a.close()));});
  for(const spec of specs){
    const cwd=path.join(dir,spec.deviceId);await mkdir(cwd);await writeFile(path.join(cwd,'same-name.txt'),spec.deviceId);
    const agent=await createCommandAgent({dataDir:path.join(cwd,'state'),spawnSsh:fakeSsh(children)});agents.push(agent);
    await agent.update({...spec,enabled:true,tunnelEnabled:true,sshHost:'example.com',sshUser:'tester',port:await freePort(),cwd,allowedPaths:[cwd]});
    const client=new Client({name:'multi-device-client',version:'1.0.0'});clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(agent.view().localUrl+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+agent.token(),'X-Device-Id':spec.deviceId}}}));
    const apiVersion=client.getServerVersion().version;
    const tools=await client.listTools();assert.ok(tools.tools.every(tool=>tool.description.includes(spec.deviceId)&&tool.description.includes(spec.deviceName)));
    assert.ok(client.getInstructions().includes(spec.deviceId));assert.match(client.getInstructions(),/Do not silently fall back/);
    const info=JSON.parse((await client.callTool({name:'get_local_info',arguments:{deviceId:spec.deviceId,apiVersion}})).content[0].text);assert.equal(info.deviceId,spec.deviceId);assert.equal(info.deviceName,spec.deviceName);
    const read=await client.callTool({name:'read_file',arguments:{deviceId:spec.deviceId,apiVersion,path:'same-name.txt'}});assert.equal(read.content[0].text.split('\n')[1],spec.deviceId);
    const resource=await client.readResource({uri:'local-tunnel://workspace',_meta:{apiVersion}});assert.equal(JSON.parse(resource.contents[0].text).deviceId,spec.deviceId);
    const bundle=connectionBundle(agent.view(),agent.token());assert.equal(bundle.deviceId,spec.deviceId);
    assert.equal(JSON.parse(bundle.generic).mcpServers[spec.deviceId].url,`http://127.0.0.1:${spec.remotePort}/mcp`);
    assert.equal(JSON.parse(bundle.generic).mcpServers[spec.deviceId].headers.Authorization,'Bearer '+agent.token());
    assert.equal(JSON.parse(bundle.generic).mcpServers[spec.deviceId].headers['X-Device-Id'],spec.deviceId);
  }
  assert.ok(children[0].args.includes(`127.0.0.1:19095:127.0.0.1:${agents[0].view().config.port}`));
  assert.ok(children[1].args.includes(`127.0.0.1:19096:127.0.0.1:${agents[1].view().config.port}`));
  const bad=await fetch(agents[1].view().localUrl+'/health',{headers:{Authorization:'Bearer '+agents[0].token()}});assert.equal(bad.status,403);
  const combined={mcpServers:{...JSON.parse(connectionBundle(agents[0].view(),agents[0].token()).generic).mcpServers,...JSON.parse(connectionBundle(agents[1].view(),agents[1].token()).generic).mcpServers}};
  assert.deepEqual(Object.keys(combined.mcpServers),['office-mac','home-mac']);
});

test('remote forwarding failures identify the affected device and exact server port',async t=>{
  const dir=await temporary(t),children=[],agent=await createCommandAgent({dataDir:dir,spawnSsh:fakeSsh(children)});t.after(()=>agent.close());
  await agent.update({deviceId:'home-mac',deviceName:'家里',enabled:true,tunnelEnabled:true,sshHost:'example.com',sshUser:'tester',remotePort:19096,port:await freePort(),cwd:dir,allowedPaths:[dir]});
  children[0].stderr.write('Error: remote port forwarding failed for listen port 19096');children[0].emit('close',255);
  assert.equal(agent.view().tunnel.state,'reconnecting');assert.match(agent.view().tunnel.error,/home-mac/);assert.match(agent.view().tunnel.error,/19096/);assert.match(agent.view().tunnel.error,/不同/);
});
