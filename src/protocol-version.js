import {createHash} from 'node:crypto';
import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const sourceDirectory=fileURLToPath(new URL('./',import.meta.url));
export function fingerprintSources(entries) {
  const normalized=entries.map(([name,source])=>[name,String(source).replace(/\r\n/g,'\n')]).sort(([a],[b])=>a<b?-1:a>b?1:0);
  return 'sha256:'+createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export async function fingerprintDirectory(directory=sourceDirectory) {
  const names=(await readdir(directory)).filter(name=>name.endsWith('.js')).sort();
  return fingerprintSources(await Promise.all(names.map(async name=>[name,await readFile(path.join(directory,name),'utf8')])));
}
// Implementation loaded by this process. It only tells whether a restart would load newer files; it never blocks calls.
export const SOURCE_VERSION=await fingerprintDirectory();
function stable(value) {
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
  return value;
}
// The API version identifies the contract clients cache (tool definitions and instructions), not the implementation,
// so fixing or editing code never invalidates connected clients. It detects a stale client rather than a forgery,
// so a short prefix of the hash is enough and costs less on every call.
export function contractVersion(contract) {
  return createHash('sha256').update(JSON.stringify(stable(contract))).digest('hex').slice(0,16);
}
export let API_VERSION;
export function setContractVersion(version) {API_VERSION=version;}
// Sources are re-hashed only when a file's name, size or modification time changes, instead of on every request.
let sourceCheck={key:null,sourceVersion:SOURCE_VERSION};
async function sourceKey(directory=sourceDirectory) {
  const names=(await readdir(directory)).filter(name=>name.endsWith('.js')).sort();
  const stats=await Promise.all(names.map(name=>stat(path.join(directory,name))));
  return names.map((name,index)=>`${name}:${stats[index].size}:${stats[index].mtimeMs}`).join('|');
}
export async function readProtocolState() {
  try {
    const key=await sourceKey();
    if(key!==sourceCheck.key)sourceCheck={key,sourceVersion:await fingerprintDirectory()};
  } catch {
    sourceCheck={key:null,sourceVersion:null};
  }
  const {sourceVersion}=sourceCheck;
  return {apiVersion:API_VERSION,sourceVersion,reloadRequired:sourceVersion!==SOURCE_VERSION};
}
export function versionFailure(error) {
  return {code:error.code,currentApiVersion:error.currentApiVersion,requestExecuted:false,
    refreshMethod:'tools/list',action:'refresh_tool_definitions_or_reconnect'};
}
export function assertApiVersion(supplied,state={apiVersion:API_VERSION}) {
  if(typeof supplied!=='string'||supplied!==state.apiVersion)throw Object.assign(new Error('接口版本过旧，请重新拉取'),{
    status:409,code:'API_VERSION_MISMATCH',currentApiVersion:state.apiVersion});
}
