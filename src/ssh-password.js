import {Client} from 'ssh2';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createHash} from 'node:crypto';
import net from 'node:net';

// Match the child-process interface used by the existing reconnect lifecycle.
export function passwordProcess(c,{test=false,ClientClass=Client}={}) {
  const child=new EventEmitter(),client=new ClientClass(),sockets=new Set();
  child.stderr=new PassThrough();
  child.kill=()=>{for(const socket of sockets)socket.destroy();client.destroy();};
  client.on('error',error=>child.stderr.write(/host.*verif/i.test(error.message)?'Host key verification failed\n':error.level==='client-authentication'?'Permission denied\n':error.code==='ECONNREFUSED'?'Connection refused\n':error.code==='ENOTFOUND'?'Could not resolve hostname\n':'SSH network connection failed\n'));
  client.once('close',()=>child.emit('close',0));
  client.on('ready',()=>{
    if(test){child.stderr.write(`Authenticated to ${c.sshHost}\n`);return;}
    client.forwardIn('127.0.0.1',c.remotePort,error=>{
      if(error){child.stderr.write('remote port forwarding failed\n');client.destroy();}
      else child.stderr.write('remote forward success\n');
    });
  });
  client.on('tcp connection',(info,accept,reject)=>{
    if(test||info.destIP!=='127.0.0.1'||info.destPort!==c.remotePort){reject();return;}
    const stream=accept(),socket=net.connect(c.port,'127.0.0.1');
    sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);stream.destroy();});
    socket.on('error',()=>stream.destroy());stream.on('error',()=>socket.destroy());
    stream.on('close',()=>socket.destroy());stream.pipe(socket).pipe(stream);
  });
  queueMicrotask(()=>{
    try{client.connect({host:c.sshHost,port:c.sshPort,username:c.sshUser,password:c.password,
      readyTimeout:10000,keepaliveInterval:5000,keepaliveCountMax:2,
      hostVerifier:key=>'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'')===c.hostFingerprint});}
    catch{child.stderr.write('SSH connection failed\n');child.emit('close',1);}
  });
  return child;
}
