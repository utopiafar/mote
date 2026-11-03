import {boundedModelFetch,modelFailureReporter,modelRequestAuthorization} from './models/http-transport.js';

export const name = "mote-context";
export const inject = ["tools", "agents", "attachments"];

/** A host receipt covers local preparation only, never remote model attention. */
export async function imageToolResult(value, attachments, receipt) {
  if(!value.image)return value;
  try{
    if(!attachments)throw Error('This model runtime does not support image attachments');
    const imageAttachment=await attachments.saveImage({data:Buffer.from(value.image.data,'base64'),mediaType:value.image.mimeType,name:'capture'});
    await receipt({token:value.imageDelivery,delivered:true});
    return {id:value.id,...(value.attachmentId?{attachmentId:value.attachmentId}:{}),...(value.imageView?{imageView:{...value.imageView,delivery:'prepared'}}:{}),...(value.imageBudget?{imageBudget:value.imageBudget}:{}),...(value.toolUsage?{toolUsage:value.toolUsage}:{}),imageAttachment};
  }catch(error){
    await receipt({token:value.imageDelivery,delivered:false}).catch(()=>undefined);
    throw error;
  }
}

export async function apply(ctx) {
  const configured=process.env.MOTE_HOST_RUN;
  if(!configured)throw new Error('A Host run session is required');
  // Resolve the query-only adapter only when the installed query plugin is activated.
  const {applyContextPlugin}=await import('./runtime/dsh/context-plugin.js');
  const {url:endpoint}=JSON.parse(configured);
  const configuration=process.env.MOTE_MODEL_TRANSPORT?JSON.parse(process.env.MOTE_MODEL_TRANSPORT):undefined;
  const original=globalThis.fetch;
  const transport=original.bind(globalThis);
  globalThis.fetch=boundedModelFetch(transport,endpoint,undefined,configuration,modelFailureReporter(transport),modelRequestAuthorization(transport));
  ctx.effect(()=>()=>{globalThis.fetch=original;});
  await applyContextPlugin(ctx);
}
