import {readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createCommandAgent} from './command-agent.js';

export async function createConnections(directory) {
  const entries=new Map(),file=path.join(directory,'connections.json');
  entries.set('default',{id:'default',name:'默认连接',agent:await createCommandAgent({dataDir:directory})});
  async function persist(){
    await writeFile(file+'.tmp',JSON.stringify([...entries.values()].map(({id,name})=>({id,name}))),{mode:0o600});
    await rename(file+'.tmp',file);
  }
  try{
    let saved=[];try{saved=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const {id,name} of saved){
      if(id==='default'){entries.get(id).name=name;continue;}
      if(!/^[a-f0-9-]{36}$/.test(id)||entries.has(id))throw Error('连接配置索引无效');
      entries.set(id,{id,name,agent:await createCommandAgent({dataDir:path.join(directory,'connections',id)})});
    }
  }catch(e){await Promise.all([...entries.values()].map(x=>x.agent.close()));throw e;}
  let busy=false;
  const fail=message=>Object.assign(Error(message),{status:400});
  return {
    get(id='default'){const entry=entries.get(id);if(!entry)throw fail('连接不存在');return entry.agent;},
    list(){return [...entries.values()].map(({id,name,agent})=>({id,name,...agent.view()}));},
    async change(input){
      if(busy)throw Object.assign(Error('连接正在更新'),{status:409});busy=true;
      try{
        if(input.action==='delete'){
          if(input.id==='default')throw fail('默认连接不能删除');
          const entry=entries.get(input.id);if(!entry)throw fail('连接不存在');
          await entry.agent.close();entries.delete(input.id);await persist();
          await rm(path.join(directory,'connections',input.id),{recursive:true,force:true});return;
        }
        if(typeof input.name!=='string'||!input.name.trim()||input.name.length>80)throw fail('请填写连接名称（最多 80 字）');
        if(input.action==='rename'){
          const entry=entries.get(input.id);if(!entry)throw fail('连接不存在');entry.name=input.name.trim();await persist();return input.id;
        }
        if(input.action!=='create'||entries.size>=30)throw fail('操作无效或连接已达 30 套');
        const id=randomUUID();await mkdir(path.join(directory,'connections'),{recursive:true});
        const agent=await createCommandAgent({dataDir:path.join(directory,'connections',id)});
        const used=new Set(this.list().map(x=>x.config.port));let port=9095;while(used.has(port))port++;
        await agent.update({port});entries.set(id,{id,name:input.name.trim(),agent});await persist();return id;
      }finally{busy=false;}
    },
    async close(){await Promise.all([...entries.values()].map(x=>x.agent.close()));}
  };
}
