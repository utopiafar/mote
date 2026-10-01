// Installed with MOTE_BACKEND_PLUGINS. Structural text normalization only.
const output={id:'community.located-text',version:'1'};
export default {
  name:'community-media-intake',inject:['moteImportIntake','moteFileProcessors','moteFileOutputs','moteFileRecipes'],
  apply(ctx){
    ctx.effect(()=>ctx.moteImportIntake.registerFormat({id:'community.text-format',version:'1',priority:10,
      probe:({prefix})=>prefix.subarray(0,10).toString()==='MOTE-TEXT\n'?{mimeType:'application/vnd.mote.text',reason:'MOTE-TEXT format signature; no semantic attribution'}:undefined}));
    ctx.effect(()=>ctx.moteFileOutputs.register({...output,kind:'text',
      parse:value=>{if(!value||typeof value.body!=='string'||value.body.length>100000)throw Error('Invalid located text');return {body:value.body};},
      project:value=>({durationMs:0,segments:[{startMs:0,endMs:0,text:value.body}]}),
    }));
    ctx.effect(()=>ctx.moteFileRecipes.registerStage({id:'community.normalize-lines',version:'1',run:context=>
      context.transform(output,async()=>{const artifact=context.readArtifact(context.dependencies.extract);return {body:artifact.transcript.segments.map(s=>s.text).join('\n').replace(/\r\n/g,'\n')};})}));
    ctx.effect(()=>ctx.moteFileRecipes.registerRecipe({id:'community.text-pipeline',version:'1',output:'normalize',steps:[
      {name:'extract',stage:{id:'mote.extract',version:'1'},dependsOn:[]},
      {name:'normalize',stage:{id:'community.normalize-lines',version:'1'},dependsOn:['extract']},
    ]}));
    ctx.effect(()=>ctx.moteFileProcessors.register({id:'community.text-extract',version:'1',name:'Example text format',stage:'extract',mediaTypes:['application/vnd.mote.text'],localOnly:true,dependencies:{settings:[],parameters:[]},output,recipe:{id:'community.text-pipeline',version:'1'},
      async process(input){const parts=[];for await(const part of input.readOriginal()){input.signal.throwIfAborted();parts.push(part);}return {body:Buffer.concat(parts).toString('utf8').slice(10)};},
    }));
  },
};
