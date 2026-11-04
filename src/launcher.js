import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {open, mkdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// A fresh clone has no node_modules, and server.js needs ssh2, so install before loading it.
const projectRoot=fileURLToPath(new URL('../',import.meta.url));
if(!existsSync(path.join(projectRoot,'node_modules','ssh2'))){
  console.log('首次运行，正在安装依赖…');
  const install=spawnSync('npm ci --omit=dev',{cwd:projectRoot,shell:true,stdio:'inherit'});
  if(install.status!==0){console.error('依赖安装失败，请检查网络后手动运行 npm ci --omit=dev。');process.exit(1);}
}
const {dataDir,root}=await import('./server.js');

const base='http://127.0.0.1:18993';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function status(){try {const r=await fetch(base+'/api/status',{signal:AbortSignal.timeout(700)});return r.ok?await r.json():null;}catch{return null;}}
function openBrowser(){
  const binary=process.platform==='win32'?'rundll32.exe':'/usr/bin/open';
  const args=process.platform==='win32'?['url.dll,FileProtocolHandler',base]:[base];
  const child=spawn(binary,args,{stdio:'ignore',detached:true});
  child.on('error',e=>console.error(`浏览器未能自动打开：${e.message}。请访问 ${base}`));child.unref();
}
try {
  const mode=process.argv[2]||'start';
  if(!['start','stop'].includes(mode))throw new Error('用法：node src/launcher.js start|stop');
  let running=await status();
  if(running && (running.app!=='local-tunnel'||running.root!==root))throw new Error('18993 端口被其他程序或另一份工具占用，请先关闭它。');
  if(mode==='stop'){
    if(!running){console.log('服务没有运行。');process.exit(0);}
    const saved=JSON.parse(await readFile(path.join(dataDir,'runtime.json'),'utf8'));
    if(saved.instance!==running.instance||saved.root!==root)throw new Error('运行状态不匹配，未停止进程。');
    const headers={'X-Local-Console':'1'};
    const session=await (await fetch(base+'/api/session',{headers})).json();
    const response=await fetch(base+'/api/shutdown',{method:'POST',headers:{...headers,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},body:'{}'});
    if(!response.ok)throw new Error('停止失败');
    for(let i=0;i<50;i++){if(!await status()){console.log('服务及隧道已停止。');process.exit(0);}await delay(200);}
    throw new Error('服务尚未退出，请检查日志。');
  }
  if(!running){
    await mkdir(dataDir,{recursive:true,mode:0o700});
    const log=await open(path.join(dataDir,'console.log'),'a',0o600);
    const child=spawn(process.execPath,[fileURLToPath(new URL('./server.js',import.meta.url))],{detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true});
    let error;child.once('error',e=>{error=e;});child.unref();await log.close();
    for(let i=0;i<50;i++){await delay(200);running=await status();if(running||error)break;}
    if(error)throw error;
    if(!running||running.root!==root)throw new Error(`启动失败，请查看 ${path.join(dataDir,'console.log')}`);
  }
  console.log(`控制台：${base}，关闭浏览器后仍在后台运行。`);if(!process.argv.includes('--no-open'))openBrowser();
}catch(e){console.error(e.message);process.exitCode=1;}
