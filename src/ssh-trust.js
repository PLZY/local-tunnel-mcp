import ssh2 from 'ssh2';
import {createHash} from 'node:crypto';

// Read only the public host key. No credentials are sent before approval.
export function inspectSshHost(c,{timeoutMs=10000}={}) {
  return new Promise((resolve,reject)=>{
    const client=new ssh2.Client();let hostKey,settled=false;
    const finish=error=>{
      if(settled)return;settled=true;clearTimeout(timer);client.destroy();
      if(hostKey)resolve(hostKey);else reject(Object.assign(Error('无法读取服务器主机密钥，请检查地址、SSH 端口及网络'),{status:400,cause:error}));
    };
    const timer=setTimeout(()=>finish(),timeoutMs);
    client.on('error',finish);client.on('close',()=>finish());
    try{client.connect({host:c.sshHost,port:c.sshPort,username:c.sshUser,readyTimeout:timeoutMs,
      hostVerifier:key=>{
        const type=ssh2.utils.parseKey(key).type;
        hostKey={fingerprint:'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,''),key:key.toString('base64'),type};
        return false;
      }});}catch(error){finish(error);}
  });
}
