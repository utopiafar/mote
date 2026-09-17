import { moteText } from '@mote/shared/i18n';
import type {SourceDocument} from '@mote/shared';
import {type Api,dateTime} from './api';
import {ArchivedFileButton} from './ArchivedFileButton';

export function SourceDocumentDetails({api,document}:{api:Api;document?:SourceDocument}){
  if(!document)return null;
  const roles:Record<string,string>={authored:moteText("用户原文"),transcript:moteText("逐字记录"),summary:moteText("摘要"),reference:moteText("引用"),other:moteText("其他内容")};
  return <section className="source-document-details" aria-label={moteText("原始资料与元数据")}><h3>{moteText("原始资料")}</h3><dl>{document.path&&<><dt>{moteText("文件")}</dt><dd>{document.path}</dd></>}{document.recordedAt&&<><dt>{moteText("原文记录时间")}</dt><dd>{dateTime(document.recordedAt)}</dd></>}{document.occurredAt&&<><dt>{moteText("事件发生时间")}</dt><dd>{dateTime(document.occurredAt)}</dd></>}{document.contentRole&&<><dt>{moteText("内容类型")}</dt><dd>{roles[document.contentRole]}</dd></>}</dl>{document.fileId&&<ArchivedFileButton api={api} id={document.fileId} name={document.path?.split('/').pop()}/>}
    {!!document.attachments?.length&&<details><summary>{moteText("关联附件（")}{document.attachments.length}）</summary>{document.attachments.map((attachment,index)=><div className="file-row" key={attachment.id||index}><div><strong>{attachment.name||attachment.path||moteText("附件 ")+(index+1)}</strong>{attachment.uri&&<small>{attachment.uri}</small>}</div>{attachment.id&&<ArchivedFileButton api={api} id={attachment.id} name={attachment.name||attachment.path?.split('/').pop()}/>}</div>)}</details>}
    {document.originalMetadata!==undefined&&<details><summary>{moteText("原始元数据")}</summary><pre>{JSON.stringify(document.originalMetadata,null,2)}</pre></details>}
  </section>;
}
