import {useMemo} from 'react';
import { moteText } from '@mote/shared/i18n';
import ReactMarkdown from 'react-markdown';
import type { Answer } from './api';

interface MarkdownNode { type:string; value?:string; url?:string; children?:MarkdownNode[] }
const citationHref = (id:string) => '#mote-evidence/' + encodeURIComponent(id);

/** A compact display excerpt, with formatting and verified reference markers removed. */
export function answerPreview(answer:Answer,limit=100) {
  let value=answer.answer;
  for(const citation of answer.citations)value=value.split('['+citation.id+']').join('');
  value=value.replace(/!\[([^\]]*)\]\([^\n)]*\)/g,'$1')
    .replace(/\[([^\]]+)\]\([^\n)]*\)/g,'$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm,'')
    .replace(/```[^\n]*\n?|\*\*|__|~~|`/g,'')
    .replace(/<[^>]*>/g,'').replace(/\s+/g,' ').trim();
  return value.length>limit?value.slice(0,limit)+'…':value;
}

/** Format only verified citation IDs in prose; preserve code and authored links. */
export function citationLinks(citations:Answer['citations']) {
  const indexes=new Map(citations.map((citation,index)=>[citation.id,index+1]));
  return () => (tree:MarkdownNode) => {
    function visit(parent:MarkdownNode) {
      if (!parent.children || ['code','inlineCode','link','linkReference','definition'].includes(parent.type)) return;
      parent.children=parent.children.flatMap(node=>{
        if (node.type!=='text' || !node.value) { visit(node);return [node]; }
        const result:MarkdownNode[]=[]; let start=0;
        for (const match of node.value.matchAll(/\[([^\]\n]{1,300})\]/g)) {
          const index=indexes.get(match[1]);if(index===undefined)continue;
          if (match.index>start) result.push({type:'text',value:node.value.slice(start,match.index)});
          result.push({type:'link',url:citationHref(match[1]),children:[{type:'text',value:moteText("来源 {0}", index)}]});
          start=match.index+match[0].length;
        }
        if (!start) return [node];
        if(start<node.value.length)result.push({type:'text',value:node.value.slice(start)});
        return result;
      });
    }
    visit(tree);
  };
}

export function AnswerMarkdown({answer,onOpen}:{answer:Answer;onOpen:(id:string)=>void}) {
  const citationIds=JSON.stringify(answer.citations.map(citation=>citation.id));
  const verified=useMemo(()=>new Map((JSON.parse(citationIds) as string[]).map(id=>[citationHref(id),id])),[citationIds]);
  // Stable renderer types keep the focused citation mounted when the shared
  // evidence dialog updates its route or switches to a nested reference.
  const components=useMemo<NonNullable<React.ComponentProps<typeof ReactMarkdown>['components']>>(()=>({
    img:()=>null,
    a:({href,children})=>{
      const id=href?verified.get(href):undefined;
      return id ? <button type="button" className="inline-citation" onClick={()=>onOpen(id)} aria-label={moteText("查看证据：{0}", children)}>{children}</button>
        : <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
    },
  }),[verified,onOpen]);
  return <ReactMarkdown skipHtml remarkPlugins={[citationLinks(answer.citations)]} components={components}>{answer.answer}</ReactMarkdown>;
}
