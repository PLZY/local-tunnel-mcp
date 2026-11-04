import {parentPort,workerData} from 'node:worker_threads';

// A catastrophic pattern cannot be interrupted on the main thread, so regex search runs here and can be terminated.
const expression=new RegExp(workerData.source,workerData.flags);
parentPort.on('message',text=>{
  const hits=[];
  text.split(/\r?\n/).forEach((line,index)=>{if(expression.test(line))hits.push(index);});
  parentPort.postMessage(hits);
});
