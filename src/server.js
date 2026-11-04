import {execFile} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {readFile, mkdir, writeFile, unlink} from 'node:fs/promises';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectionBundle} from './integrations.js';
import {readAgentJson} from './command-agent.js';
import {createConnections} from './connections.js';
import {testSshConnection} from './ssh-connection.js';

export const dataDir = path.join(os.homedir(), '.local-tunnel');
export const root = fileURLToPath(new URL('../', import.meta.url));
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const files = new Map([['/', ['index.html','text/html']], ['/app.js',['app.js','text/javascript']], ['/style.css',['style.css','text/css']], ['/icon.png',['icon.png','image/png']]]);

// Only a working shell is remembered, so installing PowerShell clears the warning without a restart.
const foundShells=new Set();
export function shellAvailable(binary,platform=process.platform) {
  if(platform!=='win32'||foundShells.has(binary))return Promise.resolve(true);
  return new Promise(resolve=>execFile(binary,['-Version'],{timeout:5000,windowsHide:true},error=>{if(!error)foundShells.add(binary);resolve(!error);}));
}

export async function createConsole({directory=dataDir, port=18993,sshTester=testSshConnection}={}) {
  const connections=await createConnections(directory);
  const agent=connections.get();
  const instance = randomBytes(24).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  let closing=false,sshTestController=null;
  function reply(res,status,value) {
    res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(JSON.stringify(value));
  }
  const server=http.createServer(async(req,res)=>{
    try {
      const host=req.headers.host||'';
      if(host!==`127.0.0.1:${server.address().port}` && host!==`localhost:${server.address().port}`)return reply(res,403,{error:'只允许本机访问'});
      if((req.headers.origin && req.headers.origin!==`http://${host}`) || req.headers['sec-fetch-site']==='cross-site')return reply(res,403,{error:'禁止跨站请求'});
      const url=new URL(req.url,`http://${host}`);
      const selected=()=>connections.get(url.searchParams.get('connection')||'default');
      if(req.method==='GET' && files.has(url.pathname)) {
        const [name,type]=files.get(url.pathname);
        res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
        return res.end(await readFile(path.join(publicDir,name)));
      }
      if(req.method==='GET' && url.pathname==='/api/status')return reply(res,200,{app:'local-tunnel',root,instance,pid:process.pid});
      if(req.headers['x-local-console']!=='1')return reply(res,403,{error:'请从本机控制页面操作'});
      if(req.method==='GET' && url.pathname==='/api/session')return reply(res,200,{csrf});
      if(req.method==='GET' && url.pathname==='/api/agent'){const view=selected().view();return reply(res,200,{...view,dataDir:directory,shellAvailable:await shellAvailable(view.config.pwshPath)});}
      if(req.method==='GET'&&url.pathname==='/api/connections')return reply(res,200,connections.list());
      const supplied=Buffer.from(req.headers['x-csrf-token']||''),expected=Buffer.from(csrf);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return reply(res,403,{error:'页面会话已过期，请刷新'});
      if(!req.headers['content-type']?.startsWith('application/json'))return reply(res,415,{error:'请使用 JSON'});
      if(req.method==='POST'&&url.pathname==='/api/connections')return reply(res,200,{id:await connections.change(await readAgentJson(req)),connections:connections.list()});
      if(req.method==='POST'&&url.pathname==='/api/ssh-host'){const {settings,...result}=await selected().prepareSsh(await readAgentJson(req));return reply(res,200,result);}
      if(req.method==='POST'&&url.pathname==='/api/trust-ssh')return reply(res,200,await selected().trustSsh(await readAgentJson(req)));
      if(req.method==='POST'&&url.pathname==='/api/test-ssh'){
        if(sshTestController)return reply(res,409,{error:'连接测试正在进行'});
        const controller=new AbortController();sshTestController=controller;
        try{
          let input=selected().sshSettings(await readAgentJson(req));
          if(sshTester===testSshConnection){const check=await selected().prepareSsh(input);if(!check.trusted)return reply(res,200,{ok:false,hostTrust:check,message:'请确认是否信任服务器'});input=check.settings;}
          return reply(res,200,await sshTester(input,{signal:controller.signal}));
        }
        finally{sshTestController=null;}
      }
      if(req.method==='PUT'&&url.pathname==='/api/agent')return reply(res,200,await selected().update(await readAgentJson(req)));
      if(req.method==='POST'&&url.pathname==='/api/integrations')return reply(res,200,connectionBundle(selected().view(),selected().token()));
      if(req.method==='POST'&&url.pathname==='/api/shutdown'){
        reply(res,200,{ok:true});setImmediate(()=>void close());return;
      }
      return reply(res,404,{error:'接口不存在'});
    }catch(e){reply(res,e.status||500,{error:e.message});}
  });
  async function close(){
    if(closing)return;closing=true;
    sshTestController?.abort();
    await connections.close();
    server.closeIdleConnections();
    await new Promise(resolve=>server.close(resolve));
  }
  try {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
  catch(e){await connections.close();throw e;}
  return {agent,server,close,instance,url:`http://127.0.0.1:${server.address().port}`};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!['darwin','win32'].includes(process.platform))throw new Error('目前支持 macOS 和 Windows');
  const app=await createConsole();
  const runtimeFile=path.join(dataDir,'runtime.json');
  await mkdir(dataDir,{recursive:true,mode:0o700});
  await writeFile(runtimeFile,JSON.stringify({url:app.url,pid:process.pid,root,instance:app.instance}),{mode:0o600});
  app.server.once('close',()=>{void unlink(runtimeFile).catch(()=>{});});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void app.close());
  console.log(`Local Tunnel: ${app.url}`);
}
