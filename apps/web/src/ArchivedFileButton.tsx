import { moteText } from '@mote/shared/i18n';
import {useState} from 'react';
import {Download} from 'lucide-react';
import {type Api,errorMessage} from './api';
import { LoadingRing } from './Loading';

export function ArchivedFileButton({api,id,name=moteText("原始文件")}:{api:Api;id:string;name?:string}) {
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function download(){
    setBusy(true);setError('');
    try{
      const response=await api.raw('/api/archived-files/'+encodeURIComponent(id)+'/content');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');link.href=url;link.download=name;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  return <span className="archived-download"><button className="button subtle" disabled={busy} aria-busy={busy} onClick={()=>void download()}>{busy?<LoadingRing/>:<Download size={14}/>}{moteText("下载原件")}</button>{error&&<span role="alert" className="download-error">{error}</span>}</span>;
}
