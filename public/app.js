const $=selector=>document.querySelector(selector);
const form=$('#settings');
let connectionId='default',connections=[],drafts=new Map();
const dismissedTrust=new Set();
let csrf='',state=null,locked=false,initialized=false,revision=0,baseline='',shellMissing=false;
const tunnelLabels={disabled:'未开启',connecting:'连接中',connected:'已连接',reconnecting:'等待重连','trust-required':'等待信任确认'};
function message(text,error=false){$('#message').textContent=text;$('#message').className=error?'notice error':'notice';}
async function request(url,method='GET',body){
  if(['/api/agent','/api/test-ssh','/api/integrations','/api/ssh-host','/api/trust-ssh'].includes(url))url+='?connection='+encodeURIComponent(connectionId);
  const response=await fetch(url,{method,headers:{'X-Local-Console':'1',...(method!=='GET'?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;
}
function snapshot(){return JSON.stringify([draft(),$('#connection-name').value]);}
const isDirty=()=>snapshot()!==baseline;
function updateSaveButton(){$('#save').disabled=locked||!isDirty();}
function valid(){
  if(form.querySelector('.advanced :invalid'))$('.advanced').open=true;
  return form.reportValidity();
}
function render(next){
  state=next;
  if(next.shellAvailable!==undefined)shellMissing=!next.shellAvailable;
  $('#device-label').textContent=next.config.deviceId;
  $('#enabled').checked=next.config.enabled;
  $('#tunnel').textContent=tunnelLabels[next.tunnel.state];
  $('#tunnel-dot').className='dot '+next.tunnel.state;
  $('#operation').textContent=next.busy?'执行中':'';
  $('#connection').textContent=`服务器端口 ${next.config.remotePort} → 本机端口 ${next.config.port}`;
  $('#pwsh-field').hidden=next.platform!=='win32';
  $('#connection-error').textContent=next.listenerError||next.tunnel.error||'';
  $('#shell-warning').textContent=shellMissing?'未检测到 PowerShell 7，AI 暂时无法执行命令。请运行 winget install --id Microsoft.PowerShell 安装。':'';
  if(!initialized){
    for(const [key,value] of Object.entries(next.config)){
      const input=form.elements.namedItem(key);if(!input)continue;
      input.value=Array.isArray(value)?value.join('\n'):value;
    }
    $('#connection-name').value=connections.find(item=>item.id===connectionId)?.name||'默认连接';
    form.elements.password.value='';
    form.elements.password.placeholder=next.config.passwordConfigured?'已保存，留空保持不变':'输入服务器密码';
    baseline=snapshot();
    const saved=drafts.get(connectionId);
    if(saved)for(const [key,value] of Object.entries(saved)){const input=key==='connectionName'?$('#connection-name'):form.elements.namedItem(key);if(input)input.value=value;}
    fitPaths();initialized=true;updateAuthFields();updateSaveButton();
  }
  if(next.hostTrust&&!locked&&!dismissedTrust.has(next.hostTrust.challenge))void action(()=>confirmTrust(next.hostTrust));
}
async function refresh(){if(locked)return;const version=revision;try{const next=await request('/api/agent');if(version===revision&&!locked){await loadConnections(version);if(version===revision&&!locked)render(next);}}catch(e){message(e.message,true);}}
async function action(fn){
  if(locked)return;locked=true;revision++;
  document.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=true);message('');
  try{await fn();}catch(e){message(e.message,true);}finally{locked=false;revision++;document.querySelectorAll('button,input,textarea,select').forEach(el=>el.disabled=false);updateSaveButton();}
}
function draft(){
  const input=Object.fromEntries(['deviceId','sshHost','sshUser','sshPort','remotePort','identityFile','authMethod','password','port','pwshPath','mcpOutputLimitKb','allowedPaths'].map(key=>[key,form.elements.namedItem(key).value]));
  input.deviceName=input.deviceId;
  for(const key of ['port','sshPort','remotePort','mcpOutputLimitKb'])input[key]=Number(input[key]);
  input.allowedPaths=input.allowedPaths.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  return input;
}
function sshDraft(){
  return Object.fromEntries(['sshHost','sshUser','identityFile','authMethod','password'].map(key=>[key,form.elements.namedItem(key).value]).concat([['sshPort',Number(form.elements.sshPort.value)]]));
}
function fitPaths(){
  const paths=form.elements.allowedPaths;
  paths.rows=Math.max(2,paths.value.split('\n').length);
}
function updateAuthFields(){
  const password=form.elements.authMethod.value==='password';
  $('#password-field').hidden=!password;$('#identity-field').hidden=password;
}
form.elements.authMethod.addEventListener('change',updateAuthFields);
form.addEventListener('input',updateSaveButton);
form.elements.allowedPaths.addEventListener('input',fitPaths);
async function saveForm(){
  const next=await request('/api/agent','PUT',draft());
  await request('/api/connections','POST',{action:'rename',id:connectionId,name:$('#connection-name').value});
  drafts.delete(connectionId);await loadConnections();initialized=false;render({...next,dataDir:state.dataDir});
}
async function confirmTrust(info){
  $('#trust-title').textContent=info.changed?'服务器主机密钥已变化':'是否信任此服务器？';
  $('#trust-description').textContent=info.changed?'这台服务器与之前保存的身份不同。确认是服务器重装或主机密钥更换后，再重新信任。':'这是首次连接这台服务器，是否信任并继续连接？';
  $('#trust-address').textContent=info.sshHost+':'+info.sshPort;
  $('#trust-fingerprint').textContent=info.fingerprint;
  $('#trust-previous').textContent=info.previousFingerprint?'原指纹：'+info.previousFingerprint:'';
  const dialog=$('#trust-dialog');dialog.showModal();
  $('#trust-accept').disabled=false;$('#trust-cancel').disabled=false;
  const accepted=await new Promise(resolve=>{
    const finish=value=>{dialog.removeEventListener('cancel',cancel);$('#trust-accept').onclick=null;$('#trust-cancel').onclick=null;dialog.close();resolve(value);};
    const cancel=event=>{event.preventDefault();finish(false);};
    dialog.addEventListener('cancel',cancel);$('#trust-accept').onclick=()=>finish(true);$('#trust-cancel').onclick=()=>finish(false);
  });
  if(!accepted){dismissedTrust.add(info.challenge);message('已取消连接，尚未信任此服务器');return false;}
  await request('/api/trust-ssh','POST',{challenge:info.challenge});return true;
}
async function ensureTrusted(input){
  const result=await request('/api/ssh-host','POST',input);
  return result.trusted||await confirmTrust(result);
}
$('#enabled').addEventListener('change',e=>{
  const enabled=e.target.checked;
  if(enabled&&!valid()){e.target.checked=false;return;}
  action(async()=>{try{
    if(enabled&&isDirty())await saveForm();
    if(enabled&&!await ensureTrusted({sshHost:state.config.sshHost,sshUser:state.config.sshUser,sshPort:state.config.sshPort,identityFile:state.config.identityFile})){ $('#enabled').checked=state.config.enabled;return; }
    render({...await request('/api/agent','PUT',{enabled,tunnelEnabled:enabled}),dataDir:state.dataDir});await loadConnections();message(enabled?'已开启':'已关闭');
  }catch(error){$('#enabled').checked=state.config.enabled;throw error;}});
});
form.addEventListener('submit',e=>{e.preventDefault();action(async()=>{await saveForm();message('已保存');});});
$('#test-ssh').addEventListener('click',()=>action(async()=>{
  const input=sshDraft();
  message('正在连接服务器…');
  if(!await ensureTrusted(input))return;
  let result=await request('/api/test-ssh','POST',input);
  if(result.hostTrust){if(!await confirmTrust(result.hostTrust))return;result=await request('/api/test-ssh','POST',input);}
  message(result.message,!result.ok);
}));
$('#copy').addEventListener('click',()=>{
  if(isDirty()&&!valid())return;
  action(async()=>{
    if(isDirty())await saveForm();
    const bundle=await request('/api/integrations','POST',{});
    await navigator.clipboard.writeText(bundle.generic);message('已复制，添加到服务器上的 AI 工具即可');
  });
});
function rememberDraft(){
  drafts.set(connectionId,{...Object.fromEntries([...form.elements].filter(el=>el.name).map(el=>[el.name,el.value])),connectionName:$('#connection-name').value});
}
async function selectConnection(id){
  if(id===connectionId)return;
  rememberDraft();const previous=connectionId;connectionId=id;
  try{const next=await request('/api/agent');initialized=false;render(next);await loadConnections();message('');}
  catch(error){connectionId=previous;await loadConnections();throw error;}
}
async function loadConnections(version){
  const items=await request('/api/connections');
  if(version!==undefined&&(version!==revision||locked))return;
  connections=items;
  $('#connections').replaceChildren(...items.map(item=>{
    const tab=document.createElement('button');tab.type='button';tab.id='tab-'+item.id;tab.setAttribute('role','tab');tab.setAttribute('aria-controls','connection-panel');
    tab.setAttribute('aria-selected',String(item.id===connectionId));tab.tabIndex=item.id===connectionId?0:-1;
    tab.className='connection-tab';tab.title=tunnelLabels[item.tunnel.state];
    const dot=document.createElement('span');dot.className='dot '+item.tunnel.state;tab.append(dot,item.name);
    tab.disabled=locked;
    tab.addEventListener('click',()=>action(()=>selectConnection(item.id)));
    tab.addEventListener('keydown',event=>{
      const index=items.findIndex(entry=>entry.id===item.id);
      const next=event.key==='ArrowRight'?items[(index+1)%items.length]:event.key==='ArrowLeft'?items[(index+items.length-1)%items.length]:event.key==='Home'?items[0]:event.key==='End'?items.at(-1):null;
      if(next){event.preventDefault();action(async()=>{await selectConnection(next.id);$('#tab-'+next.id)?.focus();});}
    });return tab;
  }));
  $('#connection-panel').setAttribute('aria-labelledby','tab-'+connectionId);
  $('#delete-connection').hidden=connectionId==='default';
}
$('#add-connection').addEventListener('click',async()=>{
  await action(async()=>{
    rememberDraft();
    const result=await request('/api/connections','POST',{action:'create',name:'新连接 '+(connections.length+1)});
    connectionId=result.id;await loadConnections();initialized=false;render(await request('/api/agent'));
  });
  form.elements.sshHost.focus();
});
$('#delete-connection').addEventListener('click',()=>{
  const name=$('#connection-name').value;
  if(!confirm(`确定删除“${name}”吗？`))return;
  action(async()=>{
    await request('/api/connections','POST',{action:'delete',id:connectionId});drafts.delete(connectionId);
    connectionId='default';await loadConnections();initialized=false;render(await request('/api/agent'));message('连接已删除');
  });
});
request('/api/session').then(session=>{csrf=session.csrf;return refresh();}).catch(e=>message(e.message,true));
setInterval(refresh,4000);
