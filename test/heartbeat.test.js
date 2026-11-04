import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createCommandAgent} from '../src/command-agent.js';
import {API_VERSION} from '../src/protocol-version.js';

const mac=process.platform==='darwin';
function freePort(){return new Promise(resolve=>{const server=net.createServer().listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});}

test('fast calls reply with plain JSON; slow calls switch to SSE with heartbeats and progress',{skip:!mac},async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-heartbeat-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const agent=await createCommandAgent({dataDir:dir,heartbeatMs:200});t.after(()=>agent.close());
  const port=await freePort();await agent.update({enabled:true,port,allowedPaths:[dir]});
  const deviceId=agent.view().config.deviceId;
  const call=(name,args={})=>fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',
    headers:{Authorization:'Bearer '+agent.token(),'X-Device-Id':deviceId,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
    body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name,_meta:{progressToken:'p1'},arguments:{deviceId,apiVersion:API_VERSION,...args}}})});

  const fast=await call('get_local_info');
  assert.match(fast.headers.get('content-type'),/application\/json/);
  assert.equal(JSON.parse((await fast.json()).result.content[0].text).roots[0].path,dir);

  const slow=await call('execute_shell',{cmd:'sleep 0.7; echo ok'});
  assert.match(slow.headers.get('content-type'),/text\/event-stream/);
  const text=await slow.text();
  assert.ok((text.match(/: heartbeat/g)||[]).length>=2);
  const messages=text.split('\n\n').filter(block=>block.startsWith('event: message')).map(block=>JSON.parse(block.slice(block.indexOf('data: ')+6)));
  assert.ok(messages.some(message=>message.method==='notifications/progress'&&message.params.progressToken==='p1'));
  const final=messages.at(-1);assert.equal(final.id,7);assert.match(final.result.content[0].text,/^exit 0.*\nok\n$/);
});
