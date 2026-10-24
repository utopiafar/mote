// R18: visible memory discovery/history and question-specific read-only context.
const mcText=(zh,en)=>state.language==='en'?en:zh;
function memoryTime(iso){
 if(!iso)return mcText('时间未记录','Time not recorded');
 return new Date(iso).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false})+' UTC+8';
}
function memoryName(kind){return kind==='original'?mcText('产品设计偏好','Product design preference'):mcText('从资料整理的记忆','Memory from materials');}
function memoryVersions(kind){
 const original=kind==='original';
 const first={text:original?originalMemorySeed:(state.generatedMemoryOriginal||state.generatedMemoryText||state.memoryContext),at:original?'2026-10-20T01:30:00.000Z':state.generatedMemoryCreatedAt||null};
 const log=state.memoryVersionLog?.[kind];
 const old=original?state.originalMemoryHistory:state.generatedMemoryHistory;
 const versions=[first,...(log||((old||[]).map(text=>({text,at:null}))))];
 return versions.map((v,i)=>({...v,index:i+1,until:versions[i+1]?.at||null,current:i===versions.length-1}));
}
function recordMemoryVersion(kind,text){
 state.memoryVersionLog=state.memoryVersionLog||{};
 state.memoryVersionLog[kind]=state.memoryVersionLog[kind]||[];
 state.memoryVersionLog[kind].push({text,at:new Date().toISOString()});
}
function memoryKinds(){return [...(!state.memoryDeleted?['original']:[]),...(state.memoryExtracted?['generated']:[])];}
function memoryMatches(kind){
 const q=(state.memorySearch||'').trim().toLowerCase();
 const versions=memoryVersions(kind),mode=state.memoryView||'current';
 const point=Date.parse((state.memoryAsOf||'2026-10-20T12:00')+':00+08:00');
 const texts=mode==='history'?versions.map(v=>v.text).join(' '):mode==='asof'?(versions.find(v=>v.at&&Date.parse(v.at)<=point&&(!v.until||Date.parse(v.until)>point))?.text||''):versions.at(-1).text;
 const names=kind==='original'?'产品设计偏好 Product design preference':'从资料整理的记忆 Memory from materials';
 return !q||(names+' '+texts).toLowerCase().includes(q);
}
function memoryBoundary(kind){return kind==='original'?mcText('适用于本人对产品界面与首次使用流程的偏好；不自动推广到其他人或其他任务。','Applies to this person’s interface and first-use preferences; do not generalize it to other people or tasks.'):mcText('仅基于所选原始资料；使用前核对资料的背景与适用范围。','Based only on the selected source materials; check their context and applicability before use.');}
function memoryMeta(kind){
 const latest=memoryVersions(kind).at(-1);
 return '<div class="evidence-box small section" data-memory-boundary="'+kind+'"><strong>'+mcText('适用边界','Applicability')+'</strong><p>'+memoryBoundary(kind)+'</p><p>'+mcText('状态：当前有效','Status: currently effective')+' · '+mcText('生效时间：','Effective from: ')+'<time data-user-content>'+esc(memoryTime(latest.at))+'</time></p></div>';
}
function memoryVersionMarkup(kind,v){
 const version=mcText('版本 ','Version ')+v.index;
 return '<article class="evidence-box section" data-memory-version="'+kind+'-'+v.index+'"><div class="flex-spread"><h3>'+memoryName(kind)+' · '+version+'</h3>'+tag(v.current?mcText('当前有效','Currently effective'):mcText('已被替代','Superseded'),v.current?'green':'')+'</div><p data-user-content>'+esc(v.text)+'</p><dl><dt>'+mcText('有效时间','Effective interval')+'</dt><dd data-user-content>'+esc(memoryTime(v.at))+' — '+esc(v.until?memoryTime(v.until):v.current?mcText('现在','Now'):mcText('时间未记录','Time not recorded'))+'</dd><dt>'+mcText('版本关系','Version relation')+'</dt><dd>'+(v.index===1?mcText('初次整理','Initial version'):mcText('人工纠正，替代版本 ','Manual correction; replaces version ')+(v.index-1))+(!v.current?' · '+mcText('已由版本 ','Replaced by version ')+(v.index+1):'')+'</dd><dt>'+mcText('矛盾关系','Conflicting memories')+'</dt><dd>'+mcText('此版本没有已标记的矛盾关联。','No conflicting relation is marked for this version.')+'</dd></dl></article>';
}
function memoryHistoryMarkup(kind){return memoryVersions(kind).map(v=>memoryVersionMarkup(kind,v)).join('');}
function memoryFilterPanel(){
 const mode=state.memoryView||'current';
 return '<section class="section" aria-label="'+mcText('查找记忆','Find memories')+'"><div class="filterbar"><label class="field" style="flex:1;min-width:180px"><span>'+mcText('搜索记忆','Search memories')+'</span><input class="field-input" id="memory-search" placeholder="'+mcText('搜索结论或记忆名称','Search a conclusion or memory name')+'" value="'+esc(state.memorySearch||'')+'"></label><label class="field"><span>'+mcText('查看版本','View versions')+'</span><select class="field-input" id="memory-view">'+[['current','当前有效','Current'],['asof','按时间回看','As of a time'],['history','全部版本','All versions']].map(x=>'<option value="'+x[0]+'" '+(mode===x[0]?'selected':'')+'>'+mcText(x[1],x[2])+'</option>').join('')+'</select></label></div>'+(mode==='asof'?'<div class="filterbar section"><label class="field"><span>'+mcText('截至时间（北京时间 UTC+8）','Snapshot time (UTC+8)')+'</span><input id="memory-asof" class="field-input" type="datetime-local" value="'+esc(state.memoryAsOf||'2026-10-20T12:00')+'"></label></div>':'')+(mode!=='current'?'<p class="small muted">'+mcText('回看不会修改当前记忆；需要纠正或继续整理时，请切回“当前有效”。','Looking back does not change the current memory. Return to Current to correct it or continue organizing.')+'</p>':'')+'</section>';
}
function memoryHistoricalView(kinds){
 const mode=state.memoryView||'current';
 if(mode==='history')return kinds.map(kind=>'<section data-history-memory="'+kind+'">'+memoryHistoryMarkup(kind)+'</section>').join('');
 const point=Date.parse((state.memoryAsOf||'2026-10-20T12:00')+':00+08:00');
 return '<p class="small muted">'+mcText('以下显示所选时间有效的版本；替代关系反映当前记录。','These versions were effective at the selected time; replacement relations reflect the current record.')+'</p>'+kinds.map(kind=>{
  const match=memoryVersions(kind).find(v=>v.at&&Date.parse(v.at)<=point&&(!v.until||Date.parse(v.until)>point));
  return match?memoryVersionMarkup(kind,match):'<div class="empty"><h3>'+memoryName(kind)+'</h3><p>'+mcText('这个时间点还没有可核对的记忆版本。','There is no verifiable version at this time.')+'</p></div>';
 }).join('');
}
function memoryNoResults(){return '<div class="empty"><h2>'+mcText('没有匹配的记忆','No matching memories')+'</h2><p>'+mcText('换个关键词，或清除搜索查看已有记忆。','Try another keyword, or clear the search to see saved memories.')+'</p>'+button(mcText('清除记忆搜索','Clear memory search'),'clear-memory-search','','subtle')+'</div>';}
function questionContextPanel(){
 const grants=state.accessGrants.filter(g=>g.active),grant=grants.find(g=>g.id===state.contextPreviewGrant)||grants[0];
 const result=state.questionContext;
 const valid=result&&grant&&grant.id===result.grantId&&grant.scope===result.scope;
 return '<section class="section card" data-question-context><h2>'+mcText('为一个问题预览首次上下文','Preview initial context for a question')+'</h2><p>'+mcText('在所选只读授权范围内预览可能交给助手的内容。不调用模型，也不改变授权。','Preview material that may be passed to the assistant within the selected read-only grant. No model is called and permissions stay unchanged.')+'</p>'+(grant?'<div class="fields section"><label class="field"><span>'+mcText('使用的只读授权','Read-only grant')+'</span><select class="field-input" id="context-preview-grant">'+grants.map(g=>'<option data-user-content value="'+esc(g.id)+'" '+(g.id===grant.id?'selected':'')+'>'+esc(g.name)+'</option>').join('')+'</select></label><p class="small">'+mcText('授权范围：','Granted scope: ')+esc(state.language==='en'?({'仅资料':'Materials only','资料与记忆':'Materials and memories','资料、记忆与洞察':'Materials, memories and insights'}[grant.scope]||grant.scope):grant.scope)+'</p><label class="field"><span>'+mcText('想了解的问题','Your question')+'</span><textarea id="context-question" placeholder="'+mcText('例如：界面设计有哪些偏好？','For example: product design preferences')+'">'+esc(state.contextQuestion||'')+'</textarea></label><div class="actions">'+button(mcText('预览首次上下文','Preview initial context'),'preview-question-context','','primary')+'</div></div>':'<div class="notice section"><div>'+mcText('还没有有效的只读授权。先明确允许读取的范围，再预览问题上下文。','There is no active read-only grant. Define the permitted scope before previewing context.')+goButton(mcText('管理只读授权','Manage read-only grants'),'settings/access','text')+'</div></div>')+(valid?'<section class="section" data-context-result><h3>'+mcText('首次上下文预览 · 未调用模型','Initial context preview · no model called')+'</h3><p data-user-content>'+esc(result.question)+'</p><p class="small">'+mcText('依据所选范围匹配的内容；预览不是回答。','Matching content within the selected scope; this preview is not an answer.')+'</p>'+(result.items.length?result.items.map(item=>'<article class="evidence-box section" data-context-item="'+esc(item.id)+'"><h4 data-user-content>'+esc(item.title)+'</h4><p data-user-content>'+esc(item.excerpt)+'</p>'+goButton(mcText('核对这项内容','Verify this content'),item.page,'text')+'</article>').join(''):'<div class="empty"><h3>'+mcText('当前范围没有匹配内容','No matching content in this scope')+'</h3><p>'+mcText('可换一个关键词；范围外的资料不会出现在这里。','Try another keyword. Materials outside the selected grant are excluded.')+'</p></div>')+'</section>':result?'<p class="notice warn">'+mcText('授权或范围已改变，请重新预览。','The grant or scope changed. Generate a new preview.')+'</p>':'')+'</section>';
}
function buildQuestionContext(){
 const question=(document.getElementById('context-question')?.value||'').trim();
 const grants=state.accessGrants.filter(g=>g.active),grant=grants.find(g=>g.id===(document.getElementById('context-preview-grant')?.value||state.contextPreviewGrant))||grants[0];
 state.contextQuestion=question;
 if(!question){notify(mcText('请先填写一个问题。','Enter a question first.'));return;}
 if(!grant){notify(mcText('先选择有效的只读授权。','Select an active read-only grant first.'));return;}
 state.contextPreviewGrant=grant.id;
 const chunks=question.toLowerCase().match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/g)||[];
 const terms=[...new Set(chunks.flatMap(x=>/[\u3400-\u9fff]/.test(x)?Array.from({length:Math.max(1,x.length-1)},(_,i)=>x.slice(i,i+2)):[x]))];
 const candidates=state.materials.map(m=>({id:m.id,title:m.title,excerpt:m.body,page:'material/'+m.id}));
 if(grant.scope.includes('记忆'))for(const kind of memoryKinds())candidates.push({id:'memory-'+kind,title:memoryName(kind),excerpt:memoryVersions(kind).at(-1).text,page:'memories'});
 if(grant.scope.includes('洞察'))for(const r of state.insightReports)candidates.push({id:r.id,title:r.question,excerpt:r.question+' · '+r.dates,page:'insights'});
 const items=candidates.map(c=>({...c,score:terms.filter(term=>(c.title+' '+c.excerpt).toLowerCase().includes(term)).length})).filter(c=>c.score>0).sort((a,b)=>b.score-a.score).slice(0,4).map(({score,...c})=>({...c,excerpt:c.excerpt.slice(0,240)}));
 state.questionContext={question,grantId:grant.id,grantName:grant.name,scope:grant.scope,items};persist();render();
}
function memoryContextAction(action){
 if(action==='clear-memory-search'){state.memorySearch='';persist();render();return true;}
 if(action==='memory-current'){state.memoryView='current';persist();render();return true;}
 if(action==='preview-question-context'){buildQuestionContext();return true;}
 return false;
}
document.addEventListener('input',e=>{
 if(e.target.id==='memory-search'){state.memorySearch=e.target.value;persist();render();}
 if(e.target.id==='context-question'){state.contextQuestion=e.target.value;persist();}
});
document.addEventListener('change',e=>{
 if(e.target.id==='memory-view'){state.memoryView=e.target.value;persist();render();}
 if(e.target.id==='memory-asof'){state.memoryAsOf=e.target.value;persist();render();}
 if(e.target.id==='context-preview-grant'){state.contextPreviewGrant=e.target.value;persist();render();}
});
Object.assign(englishLabels,{'返回上下文预览':'Back to context preview'});
