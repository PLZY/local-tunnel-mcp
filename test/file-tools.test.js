import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir,chmod,stat,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {dispatchMcp,maxReadChunk,defaultReadChunk} from '../src/agent-mcp.js';
import {checkCommandPaths,outputDirectory} from '../src/command-policy.js';
import {createCommandAgent} from '../src/command-agent.js';
import {API_VERSION} from '../src/protocol-version.js';

const backslash=String.fromCharCode(92);
async function fixture(t){
  const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-files-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const config={deviceId:'test-device',deviceName:'test-device',cwd:dir,allowedPaths:[dir]};
  const call=async(name,args={})=>(await dispatchMcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{deviceId:'test-device',apiVersion:API_VERSION,...args}}},
    {protocolState:{apiVersion:API_VERSION,sourceVersion:'x',reloadRequired:false},getConfig:()=>config,execute:()=>{throw Error('unused');},runFileOperation:fn=>fn()})).result;
  return {dir,call};
}

test('results are text only, without structuredContent',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.dir,'a.txt'),'hello\n');
  for(const [name,args] of [['get_local_info',{}],['list_directory',{}],['search_files',{pattern:'*'}],['search_content',{query:'hello'}],['read_file',{path:'a.txt'}]]){
    const result=await f.call(name,args);
    assert.equal(result.isError,false,name);assert.equal(result.structuredContent,undefined,name);assert.equal(result.content[0].type,'text',name);
  }
});

test('edit_file replaces unique text, keeps CRLF and BOM, and reports where without repeating the text',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'App.java');
  await writeFile(file,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('class A {\r\n  int a = 1;\r\n  int b = 2;\r\n}\r\n')]));
  const result=await f.call('edit_file',{path:'App.java',edits:[{oldText:'  int a = 1;\n  int b = 2;',newText:'  int a = 10;\n  int b = 20;\n  int c = 30;'}]});
  assert.equal(result.isError,false);assert.match(result.content[0].text,/^Edited: .*App\.java \(1 edits, CRLF, BOM\): line 2 -2 \+3$/);assert.doesNotMatch(result.content[0].text,/int c/);
  const written=await readFile(file);
  assert.deepEqual([...written.subarray(0,3)],[0xef,0xbb,0xbf]);
  assert.equal(written.subarray(3).toString('utf8'),'class A {\r\n  int a = 10;\r\n  int b = 20;\r\n  int c = 30;\r\n}\r\n');
});

test('edit_file writes nothing when any edit is missing or ambiguous, and dryRun never writes',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'a.txt'),original='x\ny\nx\n';
  await writeFile(file,original);
  const missing=await f.call('edit_file',{path:'a.txt',edits:[{oldText:'y',newText:'Y'},{oldText:'zzz',newText:'Z'}]});
  assert.equal(missing.isError,true);assert.match(missing.content[0].text,/edits\[1\].*not found/);
  const ambiguous=await f.call('edit_file',{path:'a.txt',edits:[{oldText:'x',newText:'X'}]});
  assert.equal(ambiguous.isError,true);assert.match(ambiguous.content[0].text,/more than once/);
  const dry=await f.call('edit_file',{path:'a.txt',edits:[{oldText:'y',newText:'Y'}],dryRun:true});
  assert.equal(dry.isError,false);assert.match(dry.content[0].text,/Dry run/);
  assert.equal(await readFile(file,'utf8'),original);
  const empty=await f.call('edit_file',{path:'a.txt',edits:[{oldText:'',newText:'Y'}]});assert.equal(empty.isError,true);
  const removeLine=(await f.call('edit_file',{path:'a.txt',edits:[{oldText:'y\n',newText:''}],dryRun:true})).content[0].text;
  assert.match(removeLine,/@@ line 2 -1 \+0\n-y$/,'a trailing newline does not count as an extra line');
  const outside=await f.call('edit_file',{path:path.join(os.tmpdir(),'outside.txt'),edits:[{oldText:'a',newText:'b'}]});assert.equal(outside.isError,true);
});

test('edit_file diff leaves out the unchanged lines at both ends of a replacement',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'a.txt');
  await writeFile(file,'one\ntwo\nthree\nfour\n');
  const diff=async(oldText,newText)=>(await f.call('edit_file',{path:'a.txt',edits:[{oldText,newText}],dryRun:true})).content[0].text.split('\n').slice(1).join('\n');
  assert.equal(await diff('one\ntwo\nthree','one\nTWO\nthree'),'@@ line 2 -1 +1\n-two\n+TWO');
  assert.equal(await diff('two\nthree','two\nnew\nthree'),'@@ line 3 -0 +1\n+new');
  assert.equal(await diff('two\nthree\nfour','two\nfour'),'@@ line 3 -1 +0\n-three');
  assert.equal(await diff('two\nthree','two\nthree\nthree'),'@@ line 4 -0 +1\n+three');
  assert.equal(await diff('two\n','two'),'@@ line 2 -1 +1\n-two\n+two','a change to the line ending alone is still shown');
  assert.equal(await readFile(file,'utf8'),'one\ntwo\nthree\nfour\n');
  await f.call('edit_file',{path:'a.txt',edits:[{oldText:'one\ntwo',newText:'one\nTWO'}]});
  assert.equal(await readFile(file,'utf8'),'one\nTWO\nthree\nfour\n','the whole replacement is written');
});

test('write_file creates files, keeps an existing file line style, and needs createDirectories for new folders',async t=>{
  const f=await fixture(t);
  const missingParent=await f.call('write_file',{path:'new/dir/file.txt',content:'a\n'});assert.equal(missingParent.isError,true);
  const created=await f.call('write_file',{path:'new/dir/file.txt',content:'a\n',createDirectories:true});
  assert.equal(created.isError,false);assert.match(created.content[0].text,/^Created /);assert.equal(await readFile(path.join(f.dir,'new/dir/file.txt'),'utf8'),'a\n');
  await writeFile(path.join(f.dir,'crlf.txt'),'old\r\nfile\r\n');
  const overwritten=await f.call('write_file',{path:'crlf.txt',content:'new\ncontent\n'});
  assert.match(overwritten.content[0].text,/^Overwrote .*CRLF/);assert.equal(await readFile(path.join(f.dir,'crlf.txt'),'utf8'),'new\r\ncontent\r\n');
});

test('read_file returns raw text with a header, by lines or by bytes, and images as image content',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.dir,'lines.txt'),Array.from({length:10},(_,i)=>`line ${i+1}`).join('\r\n')+'\r\n');
  const page=(await f.call('read_file',{path:'lines.txt',startLine:3,lineCount:2})).content[0].text;
  assert.match(page,/lines 3-4 of 10 \(more: startLine=5\)\nline 3\nline 4$/);
  const last=(await f.call('read_file',{path:'lines.txt',startLine:9})).content[0].text;assert.match(last,/lines 9-10 of 10\n/);assert.doesNotMatch(last,/more:/);
  assert.equal((await f.call('read_file',{path:'lines.txt',startLine:11})).isError,true);
  const bytes=(await f.call('read_file',{path:'lines.txt'})).content[0].text;assert.match(bytes,/^\[.*lines\.txt\] bytes 0-\d+ of \d+\nline 1/);
  assert.ok(!bytes.includes(backslash+'r'),'text must not be JSON-escaped');
  assert.equal((await f.call('read_file',{path:'lines.txt',startLine:1,offset:0})).isError,true);
  const numbered=(await f.call('read_file',{path:'lines.txt',lineNumbers:true})).content[0].text;
  assert.match(numbered,/lines 1-10 of 10\n1: line 1\n2: line 2\n/);assert.match(numbered,/\n10: line 10$/);
  assert.match((await f.call('read_file',{path:'lines.txt',startLine:3,lineCount:2,lineNumbers:true})).content[0].text,/\n3: line 3\n4: line 4$/);
  assert.match((await f.call('read_file',{path:'lines.txt',lineNumbers:false})).content[0].text,/bytes 0-\d+ of \d+\nline 1/);
  assert.equal((await f.call('read_file',{path:'lines.txt',lineNumbers:true,offset:0})).isError,true);
  assert.equal((await f.call('read_file',{path:'lines.txt',lineNumbers:true,encoding:'base64'})).isError,true);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=';
  await writeFile(path.join(f.dir,'shot.png'),Buffer.from(png,'base64'));
  const image=await f.call('read_file',{path:'shot.png'});assert.equal(image.content[0].type,'image');assert.equal(image.content[0].data,png);
  const raw=(await f.call('read_file',{path:'shot.png',encoding:'base64'})).content[0];assert.equal(raw.type,'text');assert.ok(raw.text.endsWith(png));
});

test('list_directory shows an indented tree with a depth',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.dir,'src','deep'),{recursive:true});await writeFile(path.join(f.dir,'src','deep','x.txt'),'x');
  const shallow=(await f.call('list_directory',{})).content[0].text;assert.match(shallow,/\n  src\//);assert.doesNotMatch(shallow,/deep/);
  const deep=(await f.call('list_directory',{depth:3})).content[0].text;assert.match(deep,/\n    deep\/\n      x\.txt/);
});

test('search_content supports regex, files and count modes, and context lines',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.dir,'src'));await mkdir(path.join(f.dir,'target'));
  await writeFile(path.join(f.dir,'src','A.java'),'a\nfoo1\nb\nfoo22\nc\n');await writeFile(path.join(f.dir,'src','B.java'),'foo3\n');
  await writeFile(path.join(f.dir,'target','A.class.txt'),'foo4\n');
  const regex=(await f.call('search_content',{query:'foo[0-9][0-9]',regex:true})).content[0].text;assert.match(regex,/A\.java\n  4: foo22$/);
  const grouped=(await f.call('search_content',{query:'foo'})).content[0].text;
  assert.equal(grouped.split('\n').filter(line=>line.endsWith('A.java')).length,1);assert.match(grouped,/A\.java\n  2: foo1\n  4: foo22\n.*B\.java\n  1: foo3/);
  const files=(await f.call('search_content',{query:'foo',outputMode:'files'})).content[0].text.split('\n');
  assert.deepEqual(files.map(line=>path.basename(line)),['A.java (2)','B.java (1)']);
  assert.match((await f.call('search_content',{query:'foo',outputMode:'count'})).content[0].text,/^3 matches/);
  const context=(await f.call('search_content',{query:'foo1',contextLines:1})).content[0].text;
  assert.match(context,/A\.java\n  1- a\n  2: foo1\n  3- b$/);
  const overlapping=(await f.call('search_content',{query:'foo',contextLines:1,path:path.join(f.dir,'src')})).content[0].text;
  assert.equal(overlapping.split('\n').filter(line=>line==='  3- b').length,1,'shared context lines are printed once');
  const bad=await f.call('search_content',{query:'(',regex:true});assert.equal(bad.isError,true);assert.match(bad.content[0].text,/Invalid regular expression/);
  assert.match((await f.call('search_content',{query:'foo',maxResults:1})).content[0].text,/more results: offset=1/);
});

test('search_content accepts a single file, and a path it cannot search is not reported as no matches',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.dir,'node_modules'));
  await writeFile(path.join(f.dir,'a.java'),'x\nneedle\ny\n');await writeFile(path.join(f.dir,'node_modules','.b.txt'),'needle\n');
  const file=path.join(f.dir,'a.java');
  assert.equal((await f.call('search_content',{path:'a.java',query:'needle'})).content[0].text,`${file}\n  2: needle`);
  assert.equal((await f.call('search_content',{path:'a.java',query:'needle',contextLines:1})).content[0].text,`${file}\n  1- x\n  2: needle\n  3- y`);
  assert.match((await f.call('search_content',{path:'a.java',query:'needle',outputMode:'count'})).content[0].text,/^1 matches/);
  assert.equal((await f.call('search_content',{path:'a.java',query:'needle',pattern:'*.txt',outputMode:'files'})).content[0].text,`${file} (1)`);
  assert.match((await f.call('search_content',{path:'node_modules/.b.txt',query:'needle'})).content[0].text,/\.b\.txt\n  1: needle/);
  assert.equal((await f.call('search_content',{path:'a.java',query:'absent'})).content[0].text,'no matches');
  const missing=(await f.call('search_content',{path:'missing.java',query:'needle'})).content[0].text;
  assert.match(missing,/^search failed\n\[1 unreadable: .*missing\.java/);
  const notDirectory=(await f.call('search_files',{path:'a.java',pattern:'*'})).content[0].text;
  assert.match(notDirectory,/^search failed\n.*Search path is not a directory/);
  assert.match((await f.call('list_directory',{path:'a.java'})).content[0].text,/^search failed\n.*Search path is not a directory/);
});

test('command output over the configured limit keeps head and tail and saves the full output for read_file',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-output-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const lines=Array.from({length:5000},(_,i)=>`line ${i+1} 中文`).join('\n')+'\n';
  const run=async limitKb=>(await dispatchMcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:process.platform==='win32'?'execute_powershell':'execute_shell',arguments:{deviceId:'test-device',apiVersion:API_VERSION,cmd:'x'}}},
    {protocolState:{apiVersion:API_VERSION,sourceVersion:'x',reloadRequired:false},getConfig:()=>({deviceId:'test-device',deviceName:'test-device',cwd:dir,allowedPaths:[dir],...(limitKb===undefined?{}:{mcpOutputLimitKb:limitKb})}),
      execute:async()=>({ok:true,code:0,stdout:lines,stderr:'',durationMs:1,truncated:false}),runFileOperation:fn=>fn()})).result.content[0].text;
  const limited=await run(4);
  assert.ok(Buffer.byteLength(limited)<4*1024+400,'returned text stays near the limit');
  assert.match(limited,/^exit 0, 1 ms\nline 1 中文\n/);assert.match(limited,/line 5000 中文\n$/);
  const saved=limited.match(/Full output: (.+?\.txt) —/)[1];assert.ok(saved.startsWith(outputDirectory));
  const call=async(name,args)=>(await dispatchMcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{deviceId:'test-device',...args}}},
    {protocolState:{apiVersion:API_VERSION,sourceVersion:'x',reloadRequired:false},getConfig:()=>({deviceId:'test-device',deviceName:'test-device',cwd:dir,allowedPaths:[dir]}),execute:()=>{throw Error('unused');},runFileOperation:fn=>fn()})).result;
  assert.match((await call('read_file',{path:saved,startLine:2500,lineCount:1})).content[0].text,/\nline 2499 中文$/);
  checkCommandPaths(`Get-Content '${saved}'`,[dir],dir);
  assert.equal(await run(0),'exit 0, 1 ms\n'+lines,'0 means unlimited');
  assert.ok(Buffer.byteLength(await run(undefined))<100*1024+400,'default limit is 100 KB');
  const agent=await createCommandAgent({dataDir:path.join(dir,'state')});t.after(()=>agent.close());
  assert.equal(agent.view().config.mcpOutputLimitKb,100);
  await assert.rejects(agent.update({mcpOutputLimitKb:-1}),/0–65536/);
  await agent.update({mcpOutputLimitKb:512});assert.equal(agent.view().config.mcpOutputLimitKb,512);
});

test('command paths: cwd and data paths stay inside the roots, programs outside them may run, escaped text is not a path',async t=>{
  const f=await fixture(t),outside=await mkdtemp(path.join(os.tmpdir(),'local-tunnel-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  const program=path.join(outside,process.platform==='win32'?'tool.exe':'tool');await writeFile(program,'');if(process.platform!=='win32')await chmod(program,0o755);
  const data=path.join(outside,'data.txt');await writeFile(data,'x');
  const check=cmd=>checkCommandPaths(cmd,[f.dir],f.dir);
  check(`"${program}" --version`);
  check(`echo '${backslash}${backslash}r${backslash}${backslash}n'`);
  check(`cat "${path.join(f.dir,'a.txt')}"`);
  assert.throws(()=>check(`cat "${data}"`),/白名单/);
  assert.throws(()=>checkCommandPaths('',[f.dir],outside),/白名单/);
  check('cat ../sibling/a.txt');
  check(`$x = @'\n${data}\n'@\nSet-Content a.txt $x`);
  check(`cat <<'EOF' > a.txt\n${data}\nEOF\n`);
  assert.throws(()=>check(`$x = @'\ntext\n'@\ncat "${data}"`),/白名单/);
});

test('edit_file replaces whole lines without resending them, checked against the two end lines',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'a.txt'),lines=n=>Array.from({length:n},(_,i)=>`line ${i+1}`).join('\r\n')+'\r\n';
  await writeFile(file,lines(6));
  const edit=async(...edits)=>(await f.call('edit_file',{path:'a.txt',edits}));
  const done=await edit({startLine:2,endLine:4,startText:'line 2',endText:'line 4',newText:'two\nthree'},{startLine:6,startText:'line 6',newText:'six\n'},{oldText:'line 1',newText:'one'});
  assert.match(done.content[0].text,/\(3 edits, CRLF\): line 2 -3 \+2; line 6 -1 \+1; line 1 -1 \+1$/);
  assert.equal(await readFile(file,'utf8'),'one\r\ntwo\r\nthree\r\nline 5\r\nsix\r\n','numbers refer to the file before the call');
  await writeFile(file,lines(4));
  const stale=await edit({startLine:2,startText:'old text',newText:'x'});
  assert.equal(stale.isError,true);assert.match(stale.content[0].text,/line 2 is "line 2", which differs/);
  const wrongEnd=await edit({startLine:1,endLine:2,startText:'line 1',endText:'nope',newText:'x'});assert.equal(wrongEnd.isError,true);
  assert.match((await edit({startLine:1,endLine:2,startText:'line 1',newText:'x'})).content[0].text,/endText is required/);
  assert.match((await edit({startLine:1,newText:'x'})).content[0].text,/startText is required/);
  assert.match((await edit({startLine:9,startText:'x',newText:'x'})).content[0].text,/outside the file \(4 lines\)/);
  assert.match((await edit({startLine:1,startText:'line 1',oldText:'line 1',newText:'x'})).content[0].text,/either oldText or startLine/);
  assert.match((await edit({newText:'x'})).content[0].text,/either oldText or startLine/);
  assert.match((await edit({startLine:1,endLine:2,startText:'line 1',endText:'line 2',newText:'x'},{startLine:2,startText:'line 2',newText:'y'})).content[0].text,/overlaps/);
  assert.equal(await readFile(file,'utf8'),lines(4),'a refused call writes nothing');
  await edit({startLine:2,endLine:3,startText:'line 2',endText:'line 3',newText:''});
  assert.equal(await readFile(file,'utf8'),'line 1\r\nline 4\r\n','empty newText deletes the lines with their endings');
  await writeFile(file,'a\nb');
  await edit({startLine:2,startText:'b',newText:''});assert.equal(await readFile(file,'utf8'),'a');
  await writeFile(file,'a\nb\n');
  await edit({startLine:1,startText:'a',newText:'\n'});assert.equal(await readFile(file,'utf8'),'\nb\n','a lone newline leaves an empty line');
  await writeFile(file,'a\nb\n');
  const dry=(await f.call('edit_file',{path:'a.txt',dryRun:true,edits:[{startLine:2,startText:'b',newText:'B'}]})).content[0].text;
  assert.match(dry,/^Dry run, nothing written: .*\n@@ line 2 -1 \+1\n-b\n\+B$/);assert.equal(await readFile(file,'utf8'),'a\nb\n');
});

test('edit_file leaves the line endings of a mixed file alone outside the match',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'mixed.txt');await writeFile(file,'one\r\ntwo\nthree\nfour\r\n');
  assert.equal((await f.call('edit_file',{path:'mixed.txt',edits:[{oldText:'two',newText:'TWO'}]})).isError,false);
  assert.equal(await readFile(file,'utf8'),'one\r\nTWO\nthree\nfour\r\n');
  await f.call('edit_file',{path:'mixed.txt',edits:[{oldText:'TWO\nthree',newText:'2\n3\n3.5'}]});
  assert.equal(await readFile(file,'utf8'),'one\r\n2\n3\n3.5\nfour\r\n');
  await f.call('edit_file',{path:'mixed.txt',edits:[{oldText:'one\n2',newText:'1\n1.5\n2'}]});
  assert.equal(await readFile(file,'utf8'),'1\r\n1.5\r\n2\n3\n3.5\nfour\r\n');
  assert.equal((await f.call('edit_file',{path:'mixed.txt',edits:[{oldText:'.',newText:'x'}]})).isError,true,'text is matched literally and is ambiguous here');
});

test('edits keep the mode of a file and write through a symlink',{skip:process.platform==='win32'},async t=>{
  const f=await fixture(t),file=path.join(f.dir,'run.sh'),link=path.join(f.dir,'link.sh');
  await writeFile(file,'echo a\n');await chmod(file,0o755);await symlink(file,link);
  await f.call('edit_file',{path:'link.sh',edits:[{oldText:'echo a',newText:'echo b'}]});
  await f.call('write_file',{path:'run.sh',content:'echo c\n'});
  assert.equal((await stat(file)).mode&0o777,0o755);assert.equal(await readFile(file,'utf8'),'echo c\n');
  assert.equal((await stat(link)).isFile(),true);
});

test('adjacent matches print a shared line once, as a match',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.dir,'a.txt'),'a\nhit1\nhit2\nb\n');
  assert.match((await f.call('search_content',{query:'hit',contextLines:1})).content[0].text,/a\.txt\n  1- a\n  2: hit1\n  3: hit2\n  4- b/);
});

test('a catastrophic regular expression is abandoned without blocking other work',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.dir,'slow.txt'),'a'.repeat(40)+'!\n');await writeFile(path.join(f.dir,'fast.txt'),'plain\n');
  let ticks=0;const timer=setInterval(()=>ticks++,50);t.after(()=>clearInterval(timer));
  const started=Date.now(),output=(await f.call('search_content',{query:'(a+)+$',regex:true})).content[0].text;
  assert.ok(Date.now()-started<8000);assert.ok(ticks>5,'the event loop kept running');
  assert.match(output,/1 files skipped: regular expression too slow/);
});

test('read_file by lines works on files too big to load and caps what one reply returns',async t=>{
  const f=await fixture(t);
  await writeFile(path.join(f.dir,'huge.log'),Buffer.alloc(maxReadChunk+10,'x\n'));
  const page=(await f.call('read_file',{path:'huge.log',startLine:3,lineCount:2})).content[0].text;
  assert.match(page,/lines 3-4 \(more: startLine=5\)\nx\nx$/);
  await writeFile(path.join(f.dir,'long.txt'),'a'.repeat(defaultReadChunk*2)+'\nnext\n');
  const clipped=(await f.call('read_file',{path:'long.txt',startLine:1})).content[0].text;
  assert.match(clipped.split('\n')[0],new RegExp(`lines 1-1 of 2 \\(line 1 clipped; more: offset=${defaultReadChunk}\\)$`));assert.equal(clipped.split('\n')[1].length,defaultReadChunk);
  await writeFile(path.join(f.dir,'many.txt'),('b'.repeat(99)+'\n').repeat(10000));
  const capped=(await f.call('read_file',{path:'many.txt',lineCount:9000})).content[0].text;
  assert.match(capped.split('\n')[0],/lines 1-2621 of 10000 \(more: startLine=2622\)$/);
  const end=(await f.call('read_file',{path:'many.txt',startLine:10000})).content[0].text;
  assert.match(end,/lines 10000-10000 of 10000\nb+$/);
  await writeFile(path.join(f.dir,'partial.txt'),'a\nb');
  assert.match((await f.call('read_file',{path:'partial.txt',lineNumbers:true})).content[0].text,/lines 1-2 of 2\n1: a\n2: b$/);
  await writeFile(path.join(f.dir,'empty.txt'),'');
  assert.match((await f.call('read_file',{path:'empty.txt',startLine:1})).content[0].text,/lines 1-0 of 0\n$/);
});
