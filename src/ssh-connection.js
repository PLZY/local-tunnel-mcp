import {passwordProcess} from './ssh-password.js';
import {spawn} from 'node:child_process';
import {stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fail=message=>Object.assign(new Error(message),{status:400});
export function validateSshSettings(input,{requireTarget=true}={}) {
  const c={};
  for(const key of ['sshHost','sshUser','identityFile']){
    if(typeof input[key]!=='string'||input[key].length>2048||/[\0\r\n]/.test(input[key]))throw fail(`${key} 无效`);
    c[key]=input[key].trim();
  }
  c.authMethod=input.authMethod??'key';
  if(!['key','password'].includes(c.authMethod))throw fail('认证方式无效');
  c.password=input.password??'';c.hostFingerprint=input.hostFingerprint??'';
  if(typeof c.password!=='string'||c.password.length>4096)throw fail('密码无效');
  if(typeof c.hostFingerprint!=='string'||(c.hostFingerprint&&!/^SHA256:[A-Za-z0-9+/]{43}$/.test(c.hostFingerprint)))throw fail('服务器指纹须为 SHA256 格式');
  if(requireTarget&&c.authMethod==='password'&&!c.password)throw fail('请填写 SSH 密码');
  c.sshPort=input.sshPort;
  if(!Number.isInteger(c.sshPort)||c.sshPort<1||c.sshPort>65535)throw fail('SSH 端口无效');
  if(c.sshHost&&!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(c.sshHost))throw fail('SSH 服务器地址无效');
  if(c.sshUser&&!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(c.sshUser))throw fail('SSH 用户无效');
  if(requireTarget&&(!c.sshHost||!c.sshUser))throw fail('请填写 SSH 服务器地址和登录用户');
  if(c.identityFile==='~')c.identityFile=os.homedir();
  else if(/^~[\\/]/.test(c.identityFile))c.identityFile=path.join(os.homedir(),c.identityFile.slice(2));
  return c;
}

export function sshBaseArgs(c) {
  return ['-F','none','-N','-T','-v','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
    '-o','UpdateHostKeys=no','-o','ConnectTimeout=10','-o','ConnectionAttempts=1',
    '-o','ServerAliveInterval=5','-o','ServerAliveCountMax=2','-o','ControlMaster=no','-o','ControlPath=none',
    '-o','ForwardAgent=no','-p',String(c.sshPort),
    ...(c.knownHostsFile?['-o','UserKnownHostsFile='+JSON.stringify(c.knownHostsFile.replaceAll('\\','/')),'-o','GlobalKnownHostsFile=none','-o','HostKeyAlgorithms='+(c.hostKeyType==='ssh-rsa'?'rsa-sha2-512,rsa-sha2-256':c.hostKeyType)]:[]),
    ...(c.identityFile?['-o','IdentitiesOnly=yes','-i',c.identityFile]:[])];
}

function diagnostic(message) {
  if(/ENOENT/.test(message))return '找不到 ssh 程序，请安装 OpenSSH 客户端';
  if(/Host key verification failed|No .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(message))return '服务器指纹未受信任或已变化，请在连接提示中确认是否信任服务器';
  if(/UNPROTECTED PRIVATE KEY|bad permissions|Permissions .* too open/i.test(message))return '私钥文件权限过宽，SSH 拒绝使用该私钥';
  if(/invalid format|error in libcrypto/.test(message))return '私钥格式无效或文件无法读取';
  if(/Permission denied|no supported authentication methods|sign_and_send_pubkey: signing failed/i.test(message))return 'SSH 密钥认证失败，请检查登录用户、私钥或 ssh-agent';
  if(/Connection refused/i.test(message))return '服务器拒绝连接，请检查 IP、SSH 端口及 sshd 服务';
  if(/Could not resolve hostname/i.test(message))return '服务器地址无法解析';
  if(/No route to host|Network is unreachable/i.test(message))return '无法到达服务器，请检查网络';
  return 'SSH 连接未成功，请检查地址、端口、密钥及网络';
}

// Tests authentication only: no remote command, port forward or config write is performed.
export async function testSshConnection(input,{spawnSsh=spawn,timeoutMs=12000,signal}={}) {
  const c={...validateSshSettings(input),knownHostsFile:input.knownHostsFile,hostKeyType:input.hostKeyType};
  if(c.authMethod!=='password'&&c.identityFile&&!(await stat(c.identityFile).catch(()=>null))?.isFile())throw fail('私钥文件不存在或不是普通文件');
  if(signal?.aborted)return {ok:false,message:'测试已取消',durationMs:0};
  const started=Date.now();
  return new Promise(resolve=>{
    const child=c.authMethod==='password'?passwordProcess(c,{test:true}):spawnSsh('ssh',[...sshBaseArgs(c),'-o','ClearAllForwardings=yes',`${c.sshUser}@${c.sshHost}`],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    let output='',outcome,settled=false,killTimer;
    function stop(value){
      if(outcome)return;outcome=value;child.kill();
      killTimer=setTimeout(()=>child.kill('SIGKILL'),1000);killTimer.unref();
    }
    const timer=setTimeout(()=>stop({ok:false,message:'连接超时，请检查 IP、SSH 端口和网络'}),timeoutMs);
    const abort=()=>stop({ok:false,message:'测试已取消'});
    signal?.addEventListener('abort',abort,{once:true});
    function finish(value){
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      resolve({...value,durationMs:Date.now()-started});
    }
    child.stderr.on('data',chunk=>{
      output=(output+chunk.toString()).slice(-16384);
      if(/Authenticated to [^\r\n]+|Authentication succeeded \([^)]+\)/.test(output))stop({ok:true,message:'SSH 连接成功'});
    });
    child.once('error',e=>finish({ok:false,message:diagnostic(e.code+' '+e.message)}));
    child.once('close',()=>finish(outcome??{ok:false,message:c.authMethod==='password'&&/Permission denied/.test(output)?'SSH 密码认证失败，请检查用户名、密码及服务器认证设置':diagnostic(output)}));
    if(signal?.aborted)abort();
  });
}
