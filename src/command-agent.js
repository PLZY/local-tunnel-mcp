import {inspectSshHost} from './ssh-trust.js';
import {passwordProcess} from './ssh-password.js';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile, writeFile, mkdir, rename, mkdtemp, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {checkCommandPaths} from './command-policy.js';
import {dispatchMcp,validMcpVersion} from './agent-mcp.js';
import {deviceIdentity,newDeviceIdentity,migrateDeviceIdentity,validateDeviceIdentity,assertTargetDevice} from './device-identity.js';
import {sshBaseArgs,validateSshSettings} from './ssh-connection.js';
import {assertApiVersion,readProtocolState,versionFailure} from './protocol-version.js';

export const shellName = process.platform === 'win32' ? 'PowerShell 7' : 'zsh';
const defaults = {...deviceIdentity(),enabled:false,port:9095,pwshPath:'pwsh',cwd:os.homedir(),allowedPaths:[],execBase64Enabled:0,mcpOutputLimitKb:100,
  authMethod:'key',password:'',hostFingerprint:'',tunnelEnabled:false,sshHost:'',sshPort:22,sshUser:'',identityFile:'',remotePort:19095};
const fail = (message,status=400) => Object.assign(new Error(message),{status});
// Per-stream cap: MCP repeats output as text and structuredContent, and the reply must fit in one V8 string.
export const outputLimit=64*1024*1024;
async function workingDirectory(allowedPaths) {
  for(const directory of allowedPaths)if((await stat(directory).catch(()=>null))?.isDirectory())return directory;
  return allowedPaths[0]??os.homedir();
}
function validate(input) {
  const c={...input};
  validateDeviceIdentity(c);
  c.deviceName=c.deviceName.trim();
  const expand=value=>typeof value==='string'?(value==='~'?os.homedir():/^~[\\/]/.test(value)?path.join(os.homedir(),value.slice(2)):value):value;
  for(const key of ['cwd','identityFile'])c[key]=expand(c[key]);
  if(Array.isArray(c.allowedPaths))c.allowedPaths=c.allowedPaths.map(expand);
  for(const key of ['enabled','tunnelEnabled'])if(typeof c[key]!=='boolean')throw fail(`${key} 必须是开关`);
  Object.assign(c,validateSshSettings(c,{requireTarget:c.tunnelEnabled}));
  for(const key of ['port','sshPort','remotePort'])if(!Number.isInteger(c[key])||c[key]<1||c[key]>65535)throw fail(`${key} 端口无效`);
  if(![0,1].includes(c.execBase64Enabled))throw fail('编码开关无效');
  if(!Number.isInteger(c.mcpOutputLimitKb)||c.mcpOutputLimitKb<0||c.mcpOutputLimitKb>65536)throw fail('MCP 命令输出上限须为 0–65536 KB，0 表示不限');
  for(const key of ['cwd','pwshPath','identityFile'])if(typeof c[key]!=='string'||c[key].length>2048||/[\0\r\n]/.test(c[key]))throw fail(`${key} 无效`);
  if(!c.pwshPath.trim()||!path.isAbsolute(c.cwd))throw fail('请填写 PowerShell 7 路径和绝对工作目录');
  if(typeof c.sshHost!=='string'||(c.sshHost!==''&&!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(c.sshHost))||typeof c.sshUser!=='string'||(c.sshUser!==''&&!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(c.sshUser)))throw fail('SSH 主机或用户名无效');
  if(c.tunnelEnabled&&(!c.sshHost||!c.sshUser))throw fail('请先填写并保存 SSH 服务器地址和用户名');
  if(typeof c.token!=='string'||c.token.length<32||c.token.length>256)throw fail('Token 至少 32 个字符');
  if(c.tunnelEnabled&&!c.enabled)throw fail('请先开启命令监听，再开启隧道');
  if(!Array.isArray(c.allowedPaths)||c.allowedPaths.length>30||c.allowedPaths.some(value=>typeof value!=='string'||!path.isAbsolute(value)||value.length>2048||/[\0\r\n*?]/.test(value)))throw fail('白名单最多 30 个绝对目录');
  return c;
}
export function tunnelArgs(c) {
  return [...sshBaseArgs(c),'-o','ExitOnForwardFailure=yes',
    '-R',`127.0.0.1:${c.remotePort}:127.0.0.1:${c.port}`,`${c.sshUser}@${c.sshHost}`];
}
export async function readAgentJson(req) {
  const chunks=[];
  for await(const chunk of req)chunks.push(chunk);
  try {const body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!body||Array.isArray(body)||typeof body!=='object')throw Error();return body;}
  catch{throw fail('请求必须是 JSON 对象');}
}
function json(res,status,value){
  // Serialize before writing headers so an oversized reply can still be reported as an error.
  let body;try{body=JSON.stringify(value);}catch(e){if(e instanceof RangeError)throw fail('响应超过 JavaScript 单个字符串上限，请用 offset/maxBytes 分块读取或缩小输出',413);throw e;}
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(body);
}
// A tools/call that finishes within one heartbeat interval gets a plain JSON reply. A slower one switches
// to SSE and proves it is alive on every beat: an SSE comment, plus notifications/progress when the
// client sent a progressToken (lets it reset its own timeout).
async function streamReply(res,pending,id,progressToken,interval){
  const failure=message=>JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message}});
  const serialize=reply=>{try{return JSON.stringify(reply);}catch(e){if(!(e instanceof RangeError))throw e;return failure('响应超过 JavaScript 单个字符串上限，请用 offset/maxBytes 分块读取或缩小输出');}};
  const settled=pending.then(reply=>({reply}),error=>({error}));
  let wait;const fast=await Promise.race([settled,new Promise(resolve=>{wait=setTimeout(resolve,interval);})]);
  clearTimeout(wait);
  if(fast){
    if(fast.error)throw fast.error;
    const body=serialize(fast.reply);
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(body);
  }
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
  const event=data=>'event: message\ndata: '+data+'\n\n';
  const started=Date.now()-interval;let beats=0;
  const beat=()=>{
    beats++;const seconds=Math.round((Date.now()-started)/1000);res.write(': heartbeat '+seconds+'s\n\n');
    if(progressToken!==undefined)res.write(event(JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken,progress:beats,message:'running '+seconds+'s'}})));
  };
  beat();const timer=setInterval(beat,interval);
  try{
    const {reply,error}=await settled;
    res.end(event(error?failure(error.message):serialize(reply)));
  }finally{clearInterval(timer);}
}
async function killTree(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  if(process.platform==='win32')await new Promise(resolve=>{
    const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.once('error',()=>{child.kill();resolve();});killer.once('close',resolve);
  });
  else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
}
function decodeCommand(c,body){
  let cmd=body.cmd;
  if(typeof cmd!=='string')throw fail('cmd 必须是字符串');
  if(c.execBase64Enabled===1){
    try {for(let i=0;i<2;i++){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cmd))throw Error();cmd=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(cmd,'base64'));}}
    catch{throw fail('cmd 必须是 UTF-8 命令经过两次 Base64 编码的字符串');}
  }
  if(!cmd.trim())throw fail('命令不能为空');
  return cmd;
}
export function executionSpec(c,file,platform=process.platform){
  return platform==='win32'?{binary:c.pwshPath,args:['-NoLogo','-NoProfile','-NonInteractive','-File',file]}:{binary:'/bin/zsh',args:['-f',file]};
}
export async function executeCommand(c,body,onChild=()=>{}) {
  const cmd=decodeCommand(c,body);
  const timeout=body.timeout??0,cwd=body.cwd??c.cwd;
  if(!Number.isSafeInteger(timeout)||timeout<0)throw fail('timeout 必须是非负整数秒，0 表示不限时');
  if(typeof cwd!=='string'||!path.isAbsolute(cwd)||!(await stat(cwd).catch(()=>null))?.isDirectory())throw fail('cwd 必须是存在的绝对目录');
  const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-command-'));
  const file=path.join(dir,process.platform==='win32'?'command.ps1':'command.zsh');
  const encoded=Buffer.from(cmd,'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\nif ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }\nif ($PSVersionTable.PSVersion.Major -lt 7) { Write-Error 'PowerShell 7 required'; exit 1 }\ntry {\n & ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))))\n if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }\n} catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }\n`;
  await writeFile(file,process.platform==='win32'?script:cmd,'utf8');
  const start=Date.now();
  try{return await new Promise(resolve=>{
    const spec=executionSpec(c,file);
    const child=spawn(spec.binary,spec.args,{cwd,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    onChild(child);let stdout=[],stderr=[],timedOut=false,error='';
    const stop=()=>{void killTree(child);};
    let timer;
    if(timeout){const deadline=Date.now()+timeout*1000;const arm=()=>{const remaining=deadline-Date.now();if(remaining<=0){timedOut=true;stop();}else timer=setTimeout(arm,Math.min(remaining,2147483647));};arm();}
    const kept={stdout:0,stderr:0},total={stdout:0,stderr:0};
    const capture=(name,target)=>chunk=>{total[name]+=chunk.length;const room=outputLimit-kept[name];if(room<=0)return;const part=chunk.length>room?chunk.subarray(0,room):chunk;target.push(part);kept[name]+=part.length;};
    child.stdout.on('data',capture('stdout',stdout));child.stderr.on('data',capture('stderr',stderr));child.once('error',e=>{error=e.message;});
    child.once('close',code=>{clearTimeout(timer);onChild(null);resolve({ok:code===0&&!timedOut&&!error,code,stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8'),timedOut,truncated:total.stdout>kept.stdout||total.stderr>kept.stderr,stdoutBytes:total.stdout,stderrBytes:total.stderr,durationMs:Date.now()-start,...(error?{error}:{})});});
  });}finally{await rm(dir,{recursive:true,force:true});}
}

export async function createCommandAgent({dataDir,spawnSsh=spawn,retryDelay=5000,getProtocolState=readProtocolState,heartbeatMs=5000}) {
  const file=path.join(dataDir,'command-agent.json');
  let generation=0,pendingTrust=null;
  const trustFile=path.join(dataDir,'ssh-trust.json'),knownHostsFile=path.join(dataDir,'known_hosts');
  let trusted={};try{trusted=JSON.parse(await readFile(trustFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  let c,listener=null,ssh=null,retry=null,closing=false,active=0,operation=false;
  const commands=new Set();
  let listenerError='',tunnelState='disabled',tunnelError='',attempt=0,lastResult=null;
  try{
    const saved=JSON.parse(await readFile(file,'utf8'));
    c=validate({...defaults,...saved,cwd:os.homedir(),...migrateDeviceIdentity(saved)});
  }
  catch(e){if(e.code!=='ENOENT')throw e;c={...defaults,...newDeviceIdentity(),token:randomBytes(32).toString('hex')};}
  c.cwd=await workingDirectory(c.allowedPaths);
  async function persist(){const {cwd,...saved}=c;await mkdir(dataDir,{recursive:true,mode:0o700});await writeFile(file+'.tmp',JSON.stringify(saved,null,2),{mode:0o600});await rename(file+'.tmp',file);}
  await persist();
  function view(){return {config:{...c,token:undefined,password:undefined,passwordConfigured:!!c.password},tokenConfigured:true,platform:process.platform,shell:shellName,listening:!!listener?.listening,listenerError,busy:active>0,activeOperations:active,lastResult,tunnel:{state:tunnelState,error:tunnelError},hostTrust:pendingTrust?{...pendingTrust,key:undefined}:null,localUrl:`http://127.0.0.1:${c.port}`,remoteUrl:`http://127.0.0.1:${c.remotePort}`};}
  async function exec(body){
    if(!c.enabled||!listener?.listening)throw fail('命令监听未开启',409);
    if(operation)throw fail('配置正在更新，请稍后重试',409);
    active++;let child=null;
    try{
      const cmd=decodeCommand(c,body),cwd=body.cwd??c.cwd;
      checkCommandPaths(cmd,c.allowedPaths,cwd);
      const result=await executeCommand({...c,execBase64Enabled:0},{...body,cmd},next=>{if(next)commands.add(child=next);else commands.delete(child);});
      lastResult={time:new Date().toISOString(),ok:result.ok,code:result.code,durationMs:result.durationMs};return result;
    }finally{active--;}
  }
  const target=settings=>`${settings.sshHost}:${settings.sshPort}`;
  let trustWrite=Promise.resolve();
  function writeTrust(){
    const writing=trustWrite.catch(()=>{}).then(async()=>{
    await writeFile(trustFile+'.tmp',JSON.stringify(trusted),{mode:0o600});await rename(trustFile+'.tmp',trustFile);
    const lines=Object.entries(trusted).map(([address,key])=>{const split=address.lastIndexOf(':');const host=address.slice(0,split),port=address.slice(split+1);
      const knownHost=port==='22'?host:`[${host}]:${port}`;
      return `${knownHost} ${key.type} ${key.key}`;});
    await writeFile(knownHostsFile+'.tmp',lines.join('\n')+'\n',{mode:0o600});await rename(knownHostsFile+'.tmp',knownHostsFile);
    });trustWrite=writing;return writing;
  }
  async function prepareSsh(input){
    const version=generation;
    const settings=validateSshSettings({...c,...input,authMethod:'key'});
    const key=await inspectSshHost(settings),address=target(settings),previous=trusted[address];
    if(version!==generation||closing)throw fail('连接设置已变化，请重试',409);
    // A manually pinned fingerprint from an older configuration is already approved.
    const legacy=!previous&&target(c)===address&&c.hostFingerprint===key.fingerprint;
    if(previous?.fingerprint===key.fingerprint||legacy){
      trusted[address]=key;await writeTrust();pendingTrust=null;
      return {trusted:true,settings:{...input,hostFingerprint:key.fingerprint,knownHostsFile,hostKeyType:key.type}};
    }
    pendingTrust={...key,challenge:randomBytes(24).toString('hex'),sshHost:settings.sshHost,sshPort:settings.sshPort,changed:!!previous||!!(target(c)===address&&c.hostFingerprint),previousFingerprint:previous?.fingerprint||(target(c)===address?c.hostFingerprint:undefined),expires:Date.now()+120000};
    return {trusted:false,...pendingTrust,key:undefined};
  }
  async function trustSsh(input){
    if(operation)throw fail('配置正在更新，请稍后重试',409);
    const pending=pendingTrust;
    if(!pending||pending.challenge!==input.challenge||pending.expires<Date.now())throw fail('信任确认已过期，请重新连接');
    operation=true;
    try{
      trusted[target(pending)]={fingerprint:pending.fingerprint,key:pending.key,type:pending.type};await writeTrust();pendingTrust=null;
      if(target(c)===target(pending)&&c.tunnelEnabled){await stop();await start();}
      return {ok:true};
    }finally{operation=false;}
  }
  async function connect(){
    if(closing||!c.tunnelEnabled||!listener?.listening)return;
    tunnelState='connecting';tunnelError='';
    const version=generation;let settings=c;
    if(spawnSsh===spawn){
      try{
        const result=await prepareSsh(c);
        if(version!==generation||closing)return;
        if(!result.trusted){tunnelState='trust-required';tunnelError='请确认是否信任此服务器';return;}
        settings={...c,...result.settings};
      }catch(error){if(version!==generation||closing)return;tunnelState='reconnecting';tunnelError=error.message;retry=setTimeout(connect,retryDelay);retry.unref();return;}
    }
    const child=c.authMethod==='password'?passwordProcess(settings):spawnSsh('ssh',tunnelArgs(settings),{windowsHide:true,stdio:['ignore','ignore','pipe']});ssh=child;
    let diagnostic='';
    child.stderr.on('data',chunk=>{diagnostic=(diagnostic+chunk.toString()).slice(-8192);if(/remote forward success/.test(diagnostic)){tunnelState='connected';attempt=0;} });
    child.once('error',e=>{diagnostic=e.message;});
    child.once('close',()=>{if(ssh!==child)return;ssh=null;if(closing||!c.tunnelEnabled)return;
      tunnelState='reconnecting';tunnelError=/Host key verification failed|No .* host key is known/.test(diagnostic)?'服务器主机密钥校验失败，请重新连接并确认服务器身份。':/Permission denied/.test(diagnostic)?'SSH 认证失败，请检查密码、私钥或 ssh-agent。':/remote port forwarding failed/.test(diagnostic)?`设备 ${c.deviceId} 无法使用服务器转发端口 ${c.remotePort}：可能被另一台电脑占用，或 SSH 禁止转发。请为每台电脑设置不同的服务器转发端口。`:'SSH 连接中断，请检查网络、密钥及服务器转发配置。';
      retry=setTimeout(connect,Math.min(60000,retryDelay*2**Math.min(attempt++,4)));retry.unref();
    });
  }
  async function stop(){generation++;pendingTrust=null;clearTimeout(retry);retry=null;const old=ssh;ssh=null;if(old){const done=new Promise(resolve=>old.once('close',resolve));old.kill();await done;}tunnelState='disabled';tunnelError='';await Promise.all([...commands].map(killTree));if(listener){const oldListener=listener;listener=null;oldListener.closeIdleConnections();await new Promise(resolve=>oldListener.close(resolve));}}
  async function start(){
    listenerError='';if(!c.enabled)return;
    if(!c.allowedPaths.length||!(await stat(c.cwd).catch(()=>null))?.isDirectory()){
      listenerError='请至少添加一个存在的允许目录';return;
    }
    const candidate=http.createServer(async(req,res)=>{
      try{
        const token=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):req.headers['x-deploy-token']||'',a=Buffer.from(token),b=Buffer.from(c.token);
        if(a.length!==b.length||!timingSafeEqual(a,b))return json(res,403,{ok:false,error:'认证失败'});
        assertTargetDevice(c,req.headers['x-device-id']);
        if(req.headers.origin||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{ok:false,error:'不接受浏览器跨域请求'});
        const protocolState=await getProtocolState();res.setHeader('X-API-Version',protocolState.apiVersion);
        const url=new URL(req.url,'http://127.0.0.1');
        if(url.pathname==='/mcp'){
          if(req.method!=='POST'){res.setHeader('Allow','POST');return json(res,405,{error:'Use POST for stateless MCP'});}
          if(!validMcpVersion(req.headers['mcp-protocol-version']))return json(res,400,{error:'Unsupported MCP protocol version'});
          if(!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'Use application/json'});
          let body;try{body=await readAgentJson(req);}catch(e){return json(res,e.status||400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:e.message}});}
          const pending=dispatchMcp(body,{protocolState,getConfig:()=>c,execute:args=>exec({...args,cmd:c.execBase64Enabled===1?Buffer.from(Buffer.from(args.cmd).toString('base64')).toString('base64'):args.cmd}),runFileOperation:async fn=>{
            if(operation)throw fail('配置正在更新，请稍后重试',409);active++;
            try{return await fn();}finally{active--;}
          }});
          if(body.method==='tools/call'&&(req.headers.accept||'').includes('text/event-stream'))return streamReply(res,pending,body.id??null,body.params?._meta?.progressToken,heartbeatMs);
          const reply=await pending;
          if(reply===null){res.writeHead(202);return res.end();}
          return json(res,200,reply);
        }
        if(req.method==='GET'&&url.pathname==='/version')return json(res,200,{ok:true,...protocolState,refreshMethod:'tools/list'});
        if(req.method==='GET'&&url.pathname==='/health'){assertApiVersion(req.headers['x-api-version'],protocolState);return json(res,200,{ok:true,...protocolState,platform:process.platform,shell:shellName,busy:active>0,activeOperations:active});}
        if(req.method==='GET'&&url.pathname==='/config'){assertApiVersion(req.headers['x-api-version'],protocolState);return json(res,200,{ok:true,...protocolState,execBase64Enabled:c.execBase64Enabled});}
        if(req.method==='POST'&&url.pathname==='/exec'){
          const body=await readAgentJson(req);assertTargetDevice(c,body.deviceId);
          assertApiVersion(body.apiVersion,protocolState);
          return json(res,200,await exec(body));
        }
        json(res,404,{ok:false,error:'未知路径'});
      }catch(e){json(res,e.status||500,{ok:false,error:e.message,...(e.code==='DEVICE_MISMATCH'?{code:e.code}:{}),...(e.code==='API_VERSION_MISMATCH'||e.code==='SERVER_RELOAD_REQUIRED'?versionFailure(e):{})});}
    });
    candidate.requestTimeout=0;candidate.headersTimeout=10000;
    try{await new Promise((resolve,reject)=>{candidate.once('error',reject);candidate.listen(c.port,'127.0.0.1',resolve);});listener=candidate;connect();}
    catch(e){listenerError=e.message;}
  }
  await start();
  return {view,exec,prepareSsh,trustSsh,token:()=>c.token,sshSettings:input=>({...input,password:input.password||c.password}),
    async update(input){
      const stopOnly=(input.enabled===false||input.tunnelEnabled===false)&&Object.entries(input).every(([key,value])=>['enabled','tunnelEnabled'].includes(key)&&value===false);
      if(operation||(active>0&&!stopOnly))throw fail('请等待当前命令或配置操作完成',409);
      operation=true;
      try{
        const allowed=new Set(Object.keys(defaults));if(Object.keys(input).some(key=>!allowed.has(key)))throw fail('未知配置字段');
        const patch={...input};
        if(patch.password==='')delete patch.password;
        if(patch.deviceId!==undefined&&patch.deviceName===undefined&&c.deviceName===c.deviceId)patch.deviceName=patch.deviceId;
        if((patch.sshHost!==undefined&&patch.sshHost!==c.sshHost||patch.sshPort!==undefined&&patch.sshPort!==c.sshPort)&&patch.hostFingerprint===undefined)patch.hostFingerprint='';
        const next=validate({...c,...patch,cwd:os.homedir()});
        next.cwd=await workingDirectory(next.allowedPaths);
        if(next.enabled){
          checkCommandPaths('',next.allowedPaths,next.cwd);
          if(!(await stat(next.cwd).catch(()=>null))?.isDirectory())throw fail('请至少添加一个存在的允许目录');
        }
        await stop();c=next;await persist();await start();return view();
      }finally{operation=false;}
    },
    async rotate(){if(operation||active>0)throw fail('请等待当前操作完成',409);operation=true;try{c.token=randomBytes(32).toString('hex');await persist();return {token:c.token};}finally{operation=false;}},
    async close(){closing=true;await stop();}
  };
}
