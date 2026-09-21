import {Store} from './store.js';
// Private options arrive over IPC; credentials never appear in argv or logs.
let store:Store|undefined,timer:ReturnType<typeof setTimeout>|undefined,closing=false,lastPhysical=0,needsStartupSweep=true;
function tick(){
  if(closing||!store)return;
  try{
    const started=performance.now();
    if(needsStartupSweep){store.sweep();needsStartupSweep=false;}
    store.archive.aggregate(4,Date.now()-15000);
    if(Date.now()-lastPhysical>60000){store.measurePhysicalStorage();lastPhysical=Date.now();}
    process.send?.({type:'tick',durationMs:performance.now()-started});
  }catch{process.send?.({type:'error'});}
  timer=setTimeout(tick,1000);
}
function close(){closing=true;if(timer)clearTimeout(timer);store?.close();process.exit(0);}
process.once('message',(options:{directory:string;options:ConstructorParameters<typeof Store>[1]})=>{
  try{store=new Store(options.directory,options.options);process.send?.({type:'ready'});tick();}catch{process.send?.({type:'error'});process.exit(1);}
});
process.on('disconnect',close);process.on('SIGTERM',close);process.on('SIGINT',close);
