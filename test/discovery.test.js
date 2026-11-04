import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {discover,allowedDirectories} from '../src/file-discovery.js';
import {createConsole} from '../src/server.js';
import {connectionBundle} from '../src/integrations.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=';
async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'local-discovery-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const first=path.join(dir,'project'),second=path.join(dir,'documents');
  await mkdir(path.join(first,'src','nested'),{recursive:true});await mkdir(second);
  await mkdir(path.join(first,'node_modules','dependency'),{recursive:true});
  await writeFile(path.join(first,'package.json'),'{}');
  await writeFile(path.join(first,'src','nested','feature.js'),'const local = "needle";\n// NEEDLE 中文内容\n');
  await writeFile(path.join(first,'node_modules','dependency','secret.md'),'needle');
  await writeFile(path.join(first,'.hidden.md'),'needle');
  await writeFile(path.join(second,'部署说明.md'),'SSH 配置\nneedle 跨目录搜索\n');
  await writeFile(path.join(second,'image.png'),Buffer.from(png,'base64'));
  await writeFile(path.join(second,'large.txt'),'needle'.repeat(100));
  await writeFile(path.join(second,'binary.dat'),Buffer.from([0,1,2,3]));
  return {dir,first,second,config:{cwd:first,allowedPaths:[first,second]}};
}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}

test('find files across all roots, glob recursive paths, nested/duplicate roots and case',async t=>{
  const f=await fixture(t);
  const found=await discover(f.config,'files',{pattern:'*部署*'});assert.equal(found.results[0].path,path.join(f.second,'部署说明.md'));
  assert.equal((await discover(f.config,'files',{pattern:'**/package.json'})).results.length,1);
  assert.equal((await discover(f.config,'files',{pattern:'*.JS'})).results.length,1);
  const overlaps={...f.config,allowedPaths:[path.join(f.first,'src'),f.first,f.second]};
  assert.equal((await discover(overlaps,'files',{pattern:'*.js'})).results.length,1);
});
test('content search returns real line numbers, skips binary/large files, and paginates',async t=>{
  const f=await fixture(t);
  const result=await discover(f.config,'content',{query:'needle',maxFileBytes:100});
  assert.ok(result.results.some(r=>r.path===path.join(f.second,'部署说明.md')&&r.line===2));
  assert.equal(result.results.filter(r=>r.path.endsWith('feature.js')).length,2);
  assert.ok(result.skippedBinary>=1);assert.equal(result.skippedLarge,1);
  assert.ok(!result.results.some(r=>r.path.includes('node_modules')||r.path.endsWith('.hidden.md')));
  const first=await discover(f.config,'content',{query:'needle',maxResults:1,maxFileBytes:100});assert.equal(first.results.length,1);assert.equal(first.nextOffset,1);assert.equal(first.truncated,true);
  const next=await discover(f.config,'content',{query:'needle',maxResults:1,offset:first.nextOffset,maxFileBytes:100});assert.notDeepEqual(first.results,next.results);
  assert.equal((await discover(f.config,'content',{query:'NEEDLE',caseSensitive:true})).results.length,1);
  const clipped=await discover(f.config,'content',{query:'needle',maxLineChars:3});assert.ok(clipped.results.every(r=>r.text.length<=3&&r.textTruncated));
});
test('explicit scan budgets, ignored/hidden overrides, missing roots and traversal diagnostics',async t=>{
  const f=await fixture(t);
  const limited=await discover(f.config,'files',{maxEntries:1});assert.equal(limited.scanLimitReached,true);assert.equal(limited.truncated,true);
  const all=await discover(f.config,'content',{query:'needle',includeHidden:true,includeIgnored:true});assert.ok(all.results.some(r=>r.path.includes('node_modules')));assert.ok(all.results.some(r=>r.path.endsWith('.hidden.md')));
  const missing={...f.config,allowedPaths:[...f.config.allowedPaths,path.join(f.dir,'missing')]};
  assert.equal((await allowedDirectories(missing)).directories.at(-1).exists,false);
  const result=await discover(missing,'files',{pattern:'*.md'});assert.equal(result.errors.length,1);assert.ok(result.results.length>0);
  await assert.rejects(discover(f.config,'files',{path:f.dir}),/白名单/);
  await assert.rejects(discover({...f.config,allowedPaths:[]},'files',{}),/No allowed/);
  const shallow=await discover(f.config,'tree',{maxDepth:1});assert.equal(shallow.depthLimitReached,true);
  if(process.platform!=='win32'){
    await symlink(f.second,path.join(f.first,'outside'));
    const search=await discover(f.config,'files',{path:f.first,pattern:'*.md'});assert.equal(search.skippedSymlinks,1);assert.equal(search.results.length,0);
    const singleRoot={...f.config,allowedPaths:[f.first]};const escaped=await discover(singleRoot,'files',{path:path.join(f.first,'outside')});assert.match(escaped.errors[0].error,/outside/);
  }
});
test('official MCP SDK discovers tools/resources, searches without paths, reads images and executes shell',async t=>{
  const f=await fixture(t),app=await createConsole({directory:path.join(f.dir,'state'),port:0});t.after(()=>app.close());
  await app.agent.update({enabled:true,port:await freePort(),cwd:f.first,allowedPaths:f.config.allowedPaths});
  const client=new Client({name:'local-tunnel-interoperability-test',version:'1.0.0'});
  t.after(()=>client.close());
  const deviceId=app.agent.view().config.deviceId;
  const transport=new StreamableHTTPClientTransport(new URL(app.agent.view().localUrl+'/mcp'),{requestInit:{headers:{Authorization:'Bearer '+app.agent.token(),'X-Device-Id':deviceId}}});
  await client.connect(transport);
  const tools=await client.listTools();
  const commandTool=process.platform==='win32'?'execute_powershell':'execute_shell';
  assert.deepEqual(tools.tools.map(tool=>tool.name).sort(),['edit_file',commandTool,'get_local_info','list_directory','read_file','search_content','search_files','write_file'].sort());
  assert.match(client.getInstructions(),/use these tools directly/);
  const apiVersion=client.getServerVersion().version;
  const call=(name,args={})=>client.callTool({name,arguments:{deviceId,apiVersion,...args}});
  const info=JSON.parse((await call('get_local_info')).content[0].text);assert.equal(info.roots.length,2);assert.equal(info.apiVersion,apiVersion);
  const found=(await call('search_files',{pattern:'*部署*'})).content[0].text;assert.equal(found,path.join(f.second,'部署说明.md'));
  const read=await call('read_file',{path:found});assert.match(read.content[0].text,/跨目录搜索/);
  const image=await call('read_file',{path:path.join(f.second,'image.png')});assert.equal(image.content[0].type,'image');assert.equal(image.content[0].data,png);
  const listing=await call('list_directory',{path:f.second});assert.match(listing.content[0].text,/部署说明\.md/);
  const bad=await call('search_content',{query:''});assert.equal(bad.isError,true);
  const resources=await client.listResources();assert.equal(resources.resources[0].uri,'local-tunnel://workspace');
  const resource=await client.readResource({uri:'local-tunnel://workspace',_meta:{apiVersion}});assert.equal(JSON.parse(resource.contents[0].text).roots.length,2);
  if(process.platform==='darwin'){
    const command=await call('execute_shell',{cmd:'printf MCP-SDK-ok'});assert.match(command.content[0].text,/^exit 0.*\nMCP-SDK-ok$/);
  }
  const headers={'X-Local-Console':'1'};
  const {csrf}=await (await fetch(app.url+'/api/session',{headers})).json();
  assert.equal((await fetch(app.url+'/api/integrations',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,403);
  const bundle=await (await fetch(app.url+'/api/integrations',{method:'POST',headers:{...headers,'Content-Type':'application/json','X-CSRF-Token':csrf},body:'{}'})).json();
  const exported=JSON.parse(bundle.generic).mcpServers[app.agent.view().config.deviceId];
  assert.equal(exported.headers.Authorization,'Bearer '+app.agent.token());assert.equal(exported.url,app.agent.view().remoteUrl+'/mcp');
  assert.equal(exported.headers['X-Device-Id'],deviceId);
});
test('generic MCP export contains the configured URL, device name and authentication',()=>{
  const bundle=connectionBundle({remoteUrl:'http://127.0.0.1:29095'},'test-token');
  const exported=JSON.parse(bundle.generic).mcpServers[bundle.deviceId];
  assert.equal(exported.type,'http');assert.equal(exported.url,'http://127.0.0.1:29095/mcp');assert.equal(exported.headers.Authorization,'Bearer test-token');
  assert.equal(exported.headers['X-Device-Id'],bundle.deviceId);
});
