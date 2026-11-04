import path from 'node:path';
import os from 'node:os';
import {statSync,accessSync,existsSync,constants} from 'node:fs';

// Full command output that exceeded the MCP limit is saved here; tools may read it although it is outside the roots.
export const outputDirectory=path.join(os.tmpdir(),'local-tunnel-output');
export function isSavedOutput(file){
  const relative=path.relative(outputDirectory,path.resolve(file));
  return relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative);
}

const fail=message=>{throw Object.assign(new Error(message),{status:400});};
function inDirectory(candidate,root,paths){
  const relative=paths.relative(paths.resolve(root),paths.resolve(candidate));
  return relative===''||relative!=='..'&&!relative.startsWith('..'+paths.sep)&&!paths.isAbsolute(relative);
}
// Running a program installed elsewhere (Git Bash, psql, a JDK) is ordinary tool use, not a data access outside the roots.
function isProgram(file){
  try{
    if(!statSync(file).isFile())return false;
    if(process.platform==='win32')return /\.(exe|cmd|bat|com)$/i.test(file);
    accessSync(file,constants.X_OK);return true;
  }catch{return false;}
}
// Text that only looks like a path, such as the URL path /api/v1: its first directory does not exist.
function looksReal(file){
  return process.platform==='win32'||existsSync('/'+file.split('/')[1]);
}
// Bodies of here-strings and heredocs are data the script writes, not paths it opens.
const stripDocuments=cmd=>cmd.replace(/@(['"])\r?\n[\s\S]*?\r?\n\1@/g,' ').replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g,' ');
// Keeps well-behaved callers inside the allowed roots without getting in the way of ordinary work: the working directory
// must be inside them, and so must absolute paths written in a command, except programs and saved command output.
// Relative paths are not checked, since a script may change directory first. It is a precheck, not a sandbox.
export function checkCommandPaths(cmd,allowedPaths,cwd){
  if(!Array.isArray(allowedPaths)||!allowedPaths.length)fail('请先配置至少一个白名单目录');
  if(typeof cwd!=='string'||!path.isAbsolute(cwd))fail('工作目录必须是绝对路径');
  const paths=process.platform==='win32'?path.win32:path.posix;
  const inside=value=>allowedPaths.some(root=>inDirectory(paths.resolve(cwd,value),root,paths));
  if(!inside(cwd))fail(`路径不在白名单中：${cwd}`);
  const check=value=>{
    const absolute=paths.resolve(cwd,value);
    // The POSIX null device is ordinary shell I/O, not access to an external data file.
    if(process.platform!=='win32'&&absolute==='/dev/null')return;
    if(looksReal(absolute)&&!inside(value)&&!isProgram(absolute)&&!isSavedOutput(absolute))fail(`路径不在白名单中：${value}`);
  };
  // Drive-letter paths on Windows; UNC-like text is not treated as a path because escaped strings such as '\\r\\n' look the same.
  const isPath=process.platform==='win32'?/^[a-z]:[\\/]/i:/^\//;
  const unquoted=stripDocuments(cmd).replace(/(["'])([^"'\r\n]*)\1/g,(match,quote,value)=>{
    if(isPath.test(value)){check(value);return ' '.repeat(match.length);}
    return match;
  });
  const pattern=process.platform==='win32'?/(?:^|[^a-zA-Z0-9_])([a-z]:[\\/][^\s"'`;|<>(){},]*)/gi:/(?:^|[\s=;|&<>()])(\/[^\s"'`;|<>(){},]*)/g;
  for(const match of unquoted.matchAll(pattern))check(match[1]);
}
