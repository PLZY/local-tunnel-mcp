import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createCommandAgent} from '../src/command-agent.js';
import {API_VERSION} from '../src/protocol-version.js';

async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-target-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
  const agent=await createCommandAgent({dataDir:path.join(dir,'state')});t.after(()=>agent.close());
  await agent.update({deviceId:'office-mac',enabled:true,port,allowedPaths:[dir]});
  const url=agent.view().localUrl;
  const headers={Authorization:'Bearer '+agent.token(),'Content-Type':'application/json','X-Device-Id':'office-mac','X-API-Version':API_VERSION};
  async function rpc(method,params={}){
    const response=await fetch(url+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
    assert.equal(response.status,200);return (await response.json()).result;
  }
  return {dir,agent,url,headers,rpc};
}

test('valid token cannot bypass a missing, wrong or case-mismatched device header on any remote endpoint',async t=>{
  const f=await fixture(t);
  const requests=[['GET','/health'],['GET','/config'],['POST','/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'}],['POST','/exec',{deviceId:'office-mac',cmd:'echo forbidden'}]];
  for(const target of [undefined,'home-mac','Office-mac','office-mac, home-mac']){
    for(const [method,pathname,body] of requests){
      const headers={...f.headers};if(target===undefined)delete headers['X-Device-Id'];else headers['X-Device-Id']=target;
      const response=await fetch(f.url+pathname,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
      assert.equal(response.status,403);const result=await response.json();assert.equal(result.code,'DEVICE_MISMATCH');assert.equal(result.error,'非法请求：设备名称不一致');
    }
  }
  const headers={...f.headers};delete headers['X-Device-Id'];
  assert.equal((await fetch(f.url+'/health?deviceId=office-mac',{headers})).status,403);
  assert.equal((await (await fetch(f.url+'/health',{headers:f.headers})).json()).ok,true);
  const badToken=await fetch(f.url+'/health',{headers:{...f.headers,Authorization:'Bearer wrong-token'}});assert.equal((await badToken.json()).error,'认证失败');
  assert.equal(f.agent.view().lastResult,null);
});

test('every tool declares and enforces an explicit deviceId before validating or running the tool',async t=>{
  const f=await fixture(t),{tools}=await f.rpc('tools/list');
  for(const tool of tools){
    assert.ok(tool.inputSchema.required.includes('deviceId'));assert.deepEqual(tool.inputSchema.properties.deviceId.enum,['office-mac']);
    for(const args of [{},{deviceId:'home-mac'},{deviceId:'Office-mac'}]){
      const result=await f.rpc('tools/call',{name:tool.name,arguments:args});
      assert.equal(result.isError,true);assert.equal(result.content[0].text,'非法请求：设备名称不一致');
    }
  }
  const correct=await f.rpc('tools/call',{name:'get_local_info',arguments:{deviceId:'office-mac',apiVersion:API_VERSION}});assert.equal(JSON.parse(correct.content[0].text).deviceId,'office-mac');
  assert.equal(f.agent.view().busy,false);assert.equal(f.agent.view().lastResult,null);
});

test('wrong target cannot create a file even with the correct bearer token and connection header',{skip:process.platform!=='darwin'},async t=>{
  const f=await fixture(t),marker=path.join(f.dir,'marker.txt'),cmd='printf verified > marker.txt';
  for(const deviceId of [undefined,'home-mac']){
    const args={cmd,...(deviceId?{deviceId}:{})};
    const mcp=await f.rpc('tools/call',{name:'execute_shell',arguments:args});assert.equal(mcp.isError,true);
    const legacy=await fetch(f.url+'/exec',{method:'POST',headers:f.headers,body:JSON.stringify(args)});assert.equal(legacy.status,403);assert.equal((await legacy.json()).code,'DEVICE_MISMATCH');
    await assert.rejects(access(marker));assert.equal(f.agent.view().lastResult,null);
  }
  const valid=await f.rpc('tools/call',{name:'execute_shell',arguments:{deviceId:'office-mac',apiVersion:API_VERSION,cmd}});assert.match(valid.content[0].text,/^exit 0/);assert.equal(await readFile(marker,'utf8'),'verified');
});
