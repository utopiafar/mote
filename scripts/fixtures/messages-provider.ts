import type {ServerResponse} from 'node:http';

/** Scripted synthetic SSE replies validate transport and tools, never model semantics. */
export function writeMessagesResponse(res:ServerResponse, input:{
  stage:number; tool?:{name:string;args:unknown}; text?:string; model?:string;
  stopReason?:'end_turn'|'max_tokens'; reasoning?:boolean;
  usage?:{inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number};
}) {
  const {stage,tool}=input;
  const usage=input.usage??{inputTokens:80,outputTokens:40,cacheReadTokens:0,cacheWriteTokens:0};
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(value:Record<string,unknown>)=>res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  send({type:'message_start',message:{id:`generated-${stage}`,type:'message',role:'assistant',model:input.model??'fixture-model',content:[],stop_reason:null,usage:{input_tokens:usage.inputTokens,output_tokens:0,cache_read_input_tokens:usage.cacheReadTokens,cache_creation_input_tokens:usage.cacheWriteTokens}}});
  let index=0;
  if(input.reasoning&&tool){
    send({type:'content_block_start',index,content_block:{type:'thinking',thinking:'',signature:''}});
    send({type:'content_block_delta',index,delta:{type:'thinking_delta',thinking:'Generated fixture reasoning'}});
    send({type:'content_block_delta',index,delta:{type:'signature_delta',signature:`generated-signature-${stage}`}});
    send({type:'content_block_stop',index});index++;
  }
  send({type:'content_block_start',index,content_block:tool?{type:'tool_use',id:`generated-call-${stage}`,name:tool.name,input:{}}:{type:'text',text:''}});
  send({type:'content_block_delta',index,delta:tool?{type:'input_json_delta',partial_json:JSON.stringify(tool.args)}:{type:'text_delta',text:input.text??''}});
  send({type:'content_block_stop',index});
  send({type:'message_delta',delta:{stop_reason:tool?'tool_use':input.stopReason??'end_turn',stop_sequence:null},usage:{output_tokens:usage.outputTokens}});
  send({type:'message_stop'});res.end();
}
