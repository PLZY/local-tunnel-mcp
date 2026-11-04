import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createCommandAgent} from '../src/command-agent.js';

async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-cwd-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}

test('allowed directories alone determine working directory; skip missing roots and allow per-command cwd',{skip:process.platform!=='darwin'},async t=>{
  const dir=await temporary(t),root=path.join(dir,'project'),other=path.join(dir,'another-project');await mkdir(root);await mkdir(other);
  const agent=await createCommandAgent({dataDir:path.join(dir,'state')});t.after(()=>agent.close());
  await agent.update({enabled:true,port:await freePort(),allowedPaths:[path.join(dir,'missing'),root,other]});
  assert.equal(agent.view().config.cwd,root);
  const result=await agent.exec({cmd:'pwd'});assert.equal(result.ok,true);assert.equal(await realpath(result.stdout.trim()),await realpath(root));
  const explicit=await agent.exec({cmd:'pwd',cwd:other});assert.equal(await realpath(explicit.stdout.trim()),await realpath(other));
  const persisted=JSON.parse(await readFile(path.join(dir,'state/command-agent.json'),'utf8'));assert.equal(Object.hasOwn(persisted,'cwd'),false);
  await agent.update({allowedPaths:[other]});assert.equal(agent.view().config.cwd,other);
});
test('old saved working directory is ignored and removed without changing credentials',async t=>{
  const dir=await temporary(t),root=path.join(dir,'project');await mkdir(root);
  let agent=await createCommandAgent({dataDir:path.join(dir,'state')});const token=agent.token();
  await agent.update({allowedPaths:[root]});await agent.close();
  const file=path.join(dir,'state/command-agent.json'),saved=JSON.parse(await readFile(file,'utf8'));
  saved.cwd=os.homedir();await writeFile(file,JSON.stringify(saved));
  agent=await createCommandAgent({dataDir:path.join(dir,'state')});t.after(()=>agent.close());
  assert.equal(agent.view().config.cwd,root);assert.equal(agent.token(),token);assert.equal(Object.hasOwn(JSON.parse(await readFile(file,'utf8')),'cwd'),false);
});
test('no valid allowed root prevents enabling and never falls back to home for execution',async t=>{
  const dir=await temporary(t),missing=path.join(dir,'missing'),agent=await createCommandAgent({dataDir:path.join(dir,'state')});t.after(()=>agent.close());
  await agent.update({allowedPaths:[missing]});assert.equal(agent.view().config.cwd,missing);
  await assert.rejects(agent.update({enabled:true,port:await freePort()}),/存在的允许目录/);
  assert.equal(agent.view().listening,false);assert.equal(agent.view().config.enabled,false);
});
