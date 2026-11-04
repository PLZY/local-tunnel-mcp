import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createCommandAgent,executeCommand,executionSpec,tunnelArgs} from '../src/command-agent.js';
import {checkCommandPaths} from '../src/command-policy.js';
import {createConsole} from '../src/server.js';
import {API_VERSION} from '../src/protocol-version.js';

const mac=process.platform==='darwin';
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await wait(10);}assert.fail('condition timed out');}

test('platform-specific command invocation and loopback-only strict SSH arguments',()=>{
  assert.deepEqual(executionSpec({pwshPath:'pwsh'},'a.zsh','darwin'),{binary:'/bin/zsh',args:['-f','a.zsh']});
  assert.deepEqual(executionSpec({pwshPath:'C:\\Program Files\\PowerShell\\7\\pwsh.exe'},'a.ps1','win32'),{binary:'C:\\Program Files\\PowerShell\\7\\pwsh.exe',args:['-NoLogo','-NoProfile','-NonInteractive','-File','a.ps1']});
  const args=tunnelArgs({sshHost:'example.com',sshUser:'tester',sshPort:22,port:9095,remotePort:19095,identityFile:'/a key'});
  for(const value of ['none','BatchMode=yes','StrictHostKeyChecking=yes','ExitOnForwardFailure=yes','ForwardAgent=no','127.0.0.1:19095:127.0.0.1:9095','/a key'])assert.ok(args.includes(value));
});
test('POSIX literal path precheck covers quoted paths, redirection and boundaries',{skip:!mac},()=>{
  const check=cmd=>checkCommandPaths(cmd,['/Users/test/code'],'/Users/test/code');
  check('cat "/Users/test/code/a b.txt"');check('cat ./a');check('echo ok >./output');check('cat ../sibling');check('curl https://example.com/api/v1');check('grep "/no-such-top-level-dir/v1" a.txt');
  for(const cmd of ['cat /etc/passwd','cat "/etc/passwd"','cat /Users/test/code-other/a','echo x >/etc/test'])assert.throws(()=>check(cmd),/白名单/);
  assert.throws(()=>checkCommandPaths('',[],'/Users/test/code'),/白名单/);
});
test('null-device shell I/O is allowed without widening path or file access',{skip:!mac},async t=>{
  const cwd=await temporary(t),check=cmd=>checkCommandPaths(cmd,[cwd],cwd);
  for(const cmd of ['echo ok >/dev/null','echo ok >>/dev/null','echo ok 2>/dev/null','echo ok &>/dev/null','cat </dev/null','cat "/dev/null"',"cat '/dev/null'"])check(cmd);
  for(const file of ['/dev/zero','/dev/null-other','/dev/null/child','/dev/null/../zero','/etc/passwd'])assert.throws(()=>check(`cat "${file}"`),/白名单/);
  assert.throws(()=>checkCommandPaths('',[cwd],'/dev/null'),/白名单/);
  const agent=await createCommandAgent({dataDir:path.join(cwd,'state')});t.after(()=>agent.close());
  await agent.update({enabled:true,port:await freePort(),allowedPaths:[cwd]});
  const result=await agent.exec({cmd:'printf "hidden" >/dev/null\nprintf "hidden" >>/dev/null\nprintf "hidden" 2>/dev/null 1>&2\nprintf "hidden" &>/dev/null\ncat </dev/null\nprintf "NULL_IO_OK"'});
  assert.equal(result.ok,true);assert.equal(result.stdout,'NULL_IO_OK');assert.equal(result.stderr,'');
});
test('real zsh UTF-8, exit codes, large output and timeout kill process tree',{skip:!mac},async t=>{
  const cwd=await temporary(t),config={cwd,execBase64Enabled:0};
  const success=await executeCommand(config,{cmd:'printf "你好\\n"; pwd'});assert.equal(success.ok,true);assert.match(success.stdout,/你好/);
  assert.equal((await executeCommand(config,{cmd:'exit 23'})).code,23);
  const large=await executeCommand(config,{cmd:'printf "%200000s" x'});assert.equal(large.stdout.length,200000);assert.equal(large.truncated,false);
  const timed=await executeCommand(config,{cmd:'sleep 30 &\necho $!\nwait',timeout:1});assert.equal(timed.timedOut,true);assert.ok(timed.durationMs<5000);
  const pid=Number(timed.stdout.trim());await wait(100);assert.throws(()=>process.kill(pid,0));
});
test('MCP authentication, real file access, platform discovery, token rotation and persisted config',{skip:!mac},async t=>{
  const dir=await temporary(t),port=await freePort();
  await writeFile(path.join(dir,'中文.txt'),'本机的文件');
  let agent=await createCommandAgent({dataDir:dir});t.after(()=>agent.close());
  const original=agent.token();
  await agent.update({enabled:true,port,cwd:dir,allowedPaths:[dir]});
  const url=`http://127.0.0.1:${port}`;
  const headers={'Content-Type':'application/json',Authorization:'Bearer '+original,'X-Device-Id':agent.view().config.deviceId,'X-API-Version':API_VERSION};
  async function rpc(name,args={}){const response=await fetch(url+'/mcp',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{deviceId:agent.view().config.deviceId,apiVersion:API_VERSION,...args}}})});assert.equal(response.status,200);return (await response.json()).result;}
  assert.equal((await fetch(url+'/health')).status,403);
  assert.equal((await fetch(url+'/health',{headers:{...headers,Origin:'https://example.com'}})).status,403);
  const info=JSON.parse((await rpc('get_local_info')).content[0].text);assert.equal(info.platform,'darwin');assert.equal(info.shell,'/bin/zsh');
  assert.equal((await rpc('read_file',{path:'中文.txt'})).content[0].text.split('\n')[1],'本机的文件');
  assert.match((await rpc('list_directory')).content[0].text,/中文\.txt/);
  assert.equal((await rpc('read_file',{path:'/etc/passwd'})).isError,true);
  assert.equal((await rpc('read_file',{path:'/dev/null'})).isError,true);
  assert.match((await rpc('execute_shell',{cmd:'printf hidden >/dev/null; printf NULL_IO_OK'})).content[0].text,/\nNULL_IO_OK$/);
  assert.match((await rpc('execute_shell',{cmd:'printf "MCP中文"'})).content[0].text,/\nMCP中文$/);
  await agent.rotate();assert.equal((await fetch(url+'/health',{headers})).status,403);const rotated=agent.token();
  await agent.update({enabled:false,tunnelEnabled:false});await agent.close();
  agent=await createCommandAgent({dataDir:dir});assert.equal(agent.token(),rotated);assert.equal(agent.view().config.port,port);assert.equal(agent.view().listening,false);
  assert.equal((await stat(path.join(dir,'command-agent.json'))).mode&0o777,0o600);
  await assert.rejects(agent.update({sshHost:'-oProxyCommand=bad'}),/SSH/);
  await agent.update({cwd:'~',identityFile:'~/.ssh/id_ed25519',allowedPaths:['~']});assert.equal(agent.view().config.cwd,os.homedir());assert.equal(agent.view().config.identityFile,path.join(os.homedir(),'.ssh/id_ed25519'));
});
test('SSH success confirmation, interruption/reconnection and explicit stop cleanup',async t=>{
  const dir=await temporary(t),children=[];
  const spawnSsh=(binary,args)=>{assert.equal(binary,'ssh');assert.ok(args.includes('-R'));const child=new EventEmitter();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('close',0));};children.push(child);return child;};
  const agent=await createCommandAgent({dataDir:dir,spawnSsh,retryDelay:10});t.after(()=>agent.close());
  await agent.update({enabled:true,tunnelEnabled:true,sshHost:'example.com',sshUser:'tester',port:await freePort(),cwd:dir,allowedPaths:[dir]});
  assert.equal(agent.view().tunnel.state,'connecting');children[0].stderr.write('remote forward success for: listen 127.0.0.1');assert.equal(agent.view().tunnel.state,'connected');
  children[0].stderr.write('disconnected');children[0].emit('close',255);assert.equal(agent.view().tunnel.state,'reconnecting');
  await until(()=>children.length===2);await agent.update({enabled:false,tunnelEnabled:false});assert.equal(children[1].killed,true);assert.equal(agent.view().tunnel.state,'disabled');assert.equal(agent.view().listening,false);
  await wait(30);assert.equal(children.length,2);
});
test('console same-origin/session protections, UI assets and saved settings',async t=>{
  const dir=await temporary(t),app=await createConsole({directory:dir,port:0});t.after(()=>app.close());
  const response=await fetch(app.url);assert.equal(response.status,200);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await response.text(),/开启远程访问/);
  assert.equal((await fetch(app.url+'/app.js')).status,200);
  assert.equal((await fetch(app.url+'/api/session')).status,403);
  const headers={'X-Local-Console':'1'};
  assert.equal((await fetch(app.url+'/api/session',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
  const {csrf}=await (await fetch(app.url+'/api/session',{headers})).json();
  const modify={'Content-Type':'application/json',...headers,'X-CSRF-Token':csrf};
  assert.equal((await fetch(app.url+'/api/integrations',{method:'POST',headers:{...modify,'X-CSRF-Token':'bad'},body:'{}'})).status,403);
  const saved=await fetch(app.url+'/api/agent',{method:'PUT',headers:modify,body:JSON.stringify({sshHost:'example.com',sshUser:'tester',cwd:dir,allowedPaths:[dir]})});assert.equal(saved.status,200);
  assert.equal(JSON.parse(await readFile(path.join(dir,'command-agent.json'),'utf8')).sshHost,'example.com');
  const state=await (await fetch(app.url+'/api/agent',{headers})).json();assert.equal(state.config.token,undefined);assert.equal(state.dataDir,dir);
});

test('turning off remote access terminates an in-flight command and releases the listener',{skip:!mac},async t=>{
  const dir=await temporary(t),agent=await createCommandAgent({dataDir:dir});t.after(()=>agent.close());
  const port=await freePort();await agent.update({enabled:true,port,cwd:dir,allowedPaths:[dir]});
  const execution=agent.exec({cmd:'sleep 30'});await until(()=>agent.view().busy);await wait(50);
  const started=Date.now();await agent.update({enabled:false,tunnelEnabled:false});
  const result=await execution;assert.equal(result.ok,false);assert.ok(Date.now()-started<3000);assert.equal(agent.view().listening,false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
});
