import {useEffect,useRef,useState} from 'react';
import {commonFailureMessage,httpStatusMessage} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ApiError,errorMessage,type Api} from '../../api';

export function useMaintenanceTransfer(api:Api,refresh?:()=>void){
 const active=useRef({api,alive:true,busy:false});
 if(active.current.api!==api)active.current={api,alive:true,busy:false};
 const visit=active.current;
 const [result,setResult]=useState<{visit:typeof visit;busy:string;kind:string;message:string;error:unknown}>();
 useEffect(()=>{visit.alive=true;return()=>{visit.alive=false;};},[visit]);
 const current=()=>active.current===visit&&visit.alive;
 async function run(kind:string,work:(current:()=>boolean)=>Promise<string>){
  if(!current()||visit.busy)return;
  visit.busy=true;setResult({visit,busy:kind,kind,message:'',error:undefined});
  try{const message=await work(current);if(current()){setResult({visit,busy:'',kind,message,error:undefined});refresh?.();}}
  catch(error){if(current())setResult({visit,busy:'',kind,message:'',error});}
  finally{visit.busy=false;}
 }
 return{run,current,kind:result?.visit===visit?result.kind:'',busy:result?.visit===visit?result.busy:'',message:result?.visit===visit?result.message:'',error:result?.visit===visit?result.error:undefined};
}
export async function provideMaintenanceDownload(response:Response,name:string,current:()=>boolean){
 const blob=await response.blob();if(!current())return '';
 const url=URL.createObjectURL(blob);
 try{const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();}
 finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return moteText('已向浏览器提供下载文件，请在下载列表确认保存结果。');
}
export function maintenanceFailure(error:unknown){
 if(error instanceof SyntaxError)return moteText('请选择 Mote v2 JSON 归档文件。');
 if(error instanceof ApiError)return error.code&&commonFailureMessage(error.code,error.status)||httpStatusMessage(error.status);
 return error instanceof Error&&error.message===moteText('请选择 Mote v2 JSON 归档文件。')?error.message:moteText('操作未完成，请重试');
}
export function maintenanceTechnicalFailure(error:unknown){return error instanceof ApiError?JSON.stringify({message:error.message,status:error.status,code:error.code,requestId:error.requestId,retryAfterMs:error.retryAfterMs},null,2):error instanceof Error?error.message:errorMessage(error);}
