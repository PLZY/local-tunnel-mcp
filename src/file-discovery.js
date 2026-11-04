import path from 'node:path';
import os from 'node:os';
import {readdir, realpath, stat, open, constants} from 'node:fs/promises';
import {Worker} from 'node:worker_threads';
import {checkCommandPaths} from './command-policy.js';

// O_NONBLOCK keeps open() on a FIFO or device from hanging forever; regular files read normally.
export const readFlags=process.platform==='win32'?'r':constants.O_RDONLY|constants.O_NONBLOCK;
const ignored=new Set(['.git','node_modules','.next','dist','build','.venv','venv','__pycache__','target','out','coverage']);
// Files read in parallel during a content search; results are still collected in walk order.
const scanBatch=16;
// A pattern that needs longer than this on one file is abandoned; after a few such files the search stops trying it.
const regexFileTimeoutMs=2000,regexTimeoutLimit=3;
const inside=(candidate,root)=>{const relative=path.relative(root,candidate);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
export function resolveLocalPath(c,value=c.cwd){
  const expanded=value==='~'?os.homedir():/^~[\\/]/.test(value)?path.join(os.homedir(),value.slice(2)):value;
  const target=path.resolve(c.cwd,expanded);
  checkCommandPaths('',c.allowedPaths,target);
  return target;
}
export async function allowedDirectories(c){
  const directories=await Promise.all(c.allowedPaths.map(async directory=>{
    try{const info=await stat(directory);return {path:directory,exists:true,isDirectory:info.isDirectory()};}
    catch(e){return {path:directory,exists:e.code==='ENOENT'?false:null,error:e.code};}
  }));
  return {directories,cwd:c.cwd,searchDefaults:'Without a path, searches inspect all configured directories. Missing/inaccessible paths are reported. No paths outside these roots are searched.'};
}
async function rootsFor(c,value,allowFile=false){
  const requested=value===undefined?c.allowedPaths:[resolveLocalPath(c,value)];
  if(!requested.length)throw Error('No allowed directories configured. Set allowed directories in the local control page first.');
  const canonicalRoots=(await Promise.all(c.allowedPaths.map(root=>realpath(root).catch(()=>null)))).filter(Boolean);
  const roots=[],errors=[];
  for(const directory of requested){
    try {
      const resolved=await realpath(directory);
      if(!canonicalRoots.some(root=>inside(resolved,root)))throw Error('Resolved path is outside configured directories');
      const file=!(await stat(directory)).isDirectory();
      if(file&&!(allowFile&&value!==undefined))throw Error('Search path is not a directory');
      if(!roots.some(root=>inside(resolved,root.canonical)))roots.push({path:directory,canonical:resolved,file});
    }catch(e){errors.push({path:directory,error:e.code||e.message});}
  }
  // Remove nested roots so a file is not returned twice for overlapping configured directories.
  return {roots:roots.filter(root=>!roots.some(other=>root!==other&&inside(root.canonical,other.canonical))),errors};
}
async function* walk(directory,args,report,depth=0){
  let entries;
  try{entries=(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));}
  catch(e){report.errors.push({path:directory,error:e.code||e.message});return;}
  for(const entry of entries){
    if(report.scannedEntries>=(args.maxEntries??20000)){report.scanLimitReached=true;return;}
    if(!args.includeHidden&&entry.name.startsWith('.'))continue;
    if(!args.includeIgnored&&ignored.has(entry.name))continue;
    report.scannedEntries++;
    const target=path.join(directory,entry.name);
    // Never follow a symlink while searching. Explicit command execution has broader user permissions.
    if(entry.isSymbolicLink()){report.skippedSymlinks++;continue;}
    yield {path:target,name:entry.name,type:entry.isDirectory()?'directory':entry.isFile()?'file':'other',depth};
    if(entry.isDirectory()&&depth+1<(args.maxDepth??20))yield* walk(target,args,report,depth+1);
    else if(entry.isDirectory())report.depthLimitReached=true;
    if(report.scanLimitReached)return;
  }
}
async function* singleFile(file){
  yield {path:file,name:path.basename(file),type:'file',depth:0};
}
function glob(pattern){
  let expression='';
  for(let i=0;i<pattern.length;i++){
    const char=pattern[i];
    if(char==='*'&&pattern[i+1]==='*'){
      i++;if(pattern[i+1]==='/'){i++;expression+='(?:.*/)?';}else expression+='.*';
    }else if(char==='*')expression+='[^/]*';
    else if(char==='?')expression+='[^/]';
    else expression+=char.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  }
  return new RegExp('^'+expression+'$', 'i');
}
function literalFinder(args){
  const fold=value=>args.caseSensitive?value:value.toLowerCase(),query=fold(args.query);
  return {find:(text,lines)=>{
    if(!fold(text).includes(query))return [];
    const hits=[];
    lines.forEach((line,index)=>{if(fold(line).includes(query))hits.push(index);});
    return hits;
  },close(){}};
}
// Regex search runs on one worker thread, a file at a time, so a slow pattern never blocks other calls.
function regexFinder(args,report){
  const flags=args.caseSensitive?'':'i';
  try{new RegExp(args.query,flags);}catch(e){throw Error('Invalid regular expression: '+e.message);}
  let worker=null,queue=Promise.resolve(),failures=0;
  const close=()=>{worker?.terminate();worker=null;};
  const scan=text=>new Promise(resolve=>{
    if(failures>=regexTimeoutLimit){report.skippedSlowRegex++;resolve([]);return;}
    worker??=new Worker(new URL('./regex-worker.js',import.meta.url),{workerData:{source:args.query,flags}});
    const active=worker;
    const finish=hits=>{clearTimeout(timer);active.off('message',finish);active.off('error',abandon);resolve(hits);};
    const abandon=()=>{failures++;report.skippedSlowRegex++;close();finish([]);};
    const timer=setTimeout(abandon,regexFileTimeoutMs);
    active.on('message',finish);active.on('error',abandon);
    active.postMessage(text);
  });
  return {find:text=>queue=queue.then(()=>scan(text)),close};
}
async function scanFile(entry,args,finder,report){
  let handle;
  try {
    handle=await open(entry.path,readFlags);
    const info=await handle.stat();if(!info.isFile())return [];
    report.scannedFiles++;
    const maxBytes=args.maxFileBytes??2*1024*1024;
    if(info.size>maxBytes){report.skippedLarge++;return [];}
    // Bound the actual read as well as stat: files may grow while they are being searched.
    const buffer=Buffer.alloc(Math.min(info.size+1,maxBytes+1));
    let bytes=0;
    while(bytes<buffer.length){const read=await handle.read(buffer,bytes,buffer.length-bytes,null);if(!read.bytesRead)break;bytes+=read.bytesRead;}
    if(bytes>maxBytes){report.skippedLarge++;return [];}
    const data=buffer.subarray(0,bytes);if(data.includes(0)){report.skippedBinary++;return [];}
    const text=data.toString('utf8'),lines=text.split(/\r?\n/),maxChars=args.maxLineChars??1000,context=args.contextLines??0,found=[];
    const clip=index=>({line:index+1,text:lines[index].slice(0,maxChars),textTruncated:lines[index].length>maxChars});
    const range=(from,to)=>{const values=[];for(let i=Math.max(0,from);i<Math.min(lines.length,to);i++)values.push(clip(i));return values;};
    for(const i of await finder.find(text,lines))found.push({path:entry.path,...clip(i),...(context?{before:range(i-context,i),after:range(i+1,i+1+context)}:{})});
    return found;
  }catch(e){report.errors.push({path:entry.path,error:e.code||e.message});return [];}
  finally{await handle?.close();}
}
export async function discover(c,mode,args={}){
  const {roots,errors}=await rootsFor(c,args.path,mode==='content');
  const report={roots:roots.map(root=>root.path),errors,scannedEntries:0,scannedFiles:0,skippedSymlinks:0,skippedBinary:0,skippedLarge:0,skippedSlowRegex:0,scanLimitReached:false,depthLimitReached:false};
  const results=[],limit=args.maxResults??100,offset=args.offset??0,outputMode=args.outputMode??'content';
  let matched=0,hasMore=false,total=0;
  const pattern=glob(args.pattern??'*');
  if(mode==='content'&&!args.query)throw Error('query must not be empty');
  const finder=mode==='content'?(args.regex?regexFinder:literalFinder)(args,report):null;
  function collect(value){matched++;if(matched<=offset)return false;if(results.length>=limit){hasMore=true;return true;}results.push(value);return false;}
  // Scan queued files in parallel, then collect in walk order so pagination stays deterministic. Returns true when full.
  const pending=[];
  async function flush(){
    const scanned=await Promise.all(pending.splice(0).map(entry=>scanFile(entry,args,finder,report)));
    for(const found of scanned){
      if(!found.length)continue;
      if(outputMode==='count'){total+=found.length;continue;}
      if(outputMode==='files'){if(collect({path:found[0].path,matches:found.length}))return true;continue;}
      for(const match of found)if(collect(match))return true;
    }
    return false;
  }
  try{outer:for(const root of roots){
    for await(const entry of root.file?singleFile(root.path):walk(root.path,args,report)){
      const relative=path.relative(root.path,entry.path).split(path.sep).join('/');
      // A file named explicitly is searched whatever the pattern says.
      if(!root.file&&!pattern.test((args.pattern??'').includes('/')?relative:entry.name))continue;
      if(mode==='tree'){if(collect({...entry,root:root.path,relativePath:relative}))break outer;continue;}
      if(entry.type!=='file')continue;
      if(mode==='files'){if(collect({path:entry.path,root:root.path,relativePath:relative}))break outer;continue;}
      pending.push(entry);
      if(pending.length>=scanBatch&&await flush())break outer;
    }
    if(mode==='content'&&await flush())break;
    if(report.scanLimitReached)break;
  }}finally{finder?.close();}
  const truncated=hasMore||report.scanLimitReached||report.depthLimitReached;
  return {...report,results,...(outputMode==='count'&&mode==='content'?{count:total}:{}),offset,nextOffset:hasMore?offset+results.length:null,truncated,
    ...(truncated?{defaults:{maxEntries:args.maxEntries??20000,maxDepth:args.maxDepth??20,maxResults:limit,includeHidden:args.includeHidden??false,includeIgnored:args.includeIgnored??false,...(mode==='content'?{maxFileBytes:args.maxFileBytes??2*1024*1024,maxLineChars:args.maxLineChars??1000}:{})},
      guidance:'For truncated scans narrow path/pattern or raise maxEntries/maxDepth. Use nextOffset for more matches. Dependency/build/hidden directories and symlinks are skipped by default.'}:{})};
}