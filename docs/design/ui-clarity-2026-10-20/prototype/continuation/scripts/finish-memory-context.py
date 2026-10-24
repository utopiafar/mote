from pathlib import Path
import json

root=Path(__file__).resolve().parents[1]
source=(root/'dist/r17.html').read_text()
changes=[]
def replace(old,new,count=1):
    global source
    actual=source.count(old)
    assert actual==count,(old[:100],actual,count)
    source=source.replace(old,new)
    changes.append({'before':old,'after':new,'count':count})

replace('memoryCorrectionDraft:null,','memoryCorrectionDraft:null,memorySearch:"",memoryView:"current",memoryAsOf:"2026-10-20T12:00",memoryVersionLog:{},generatedMemoryCreatedAt:null,contextQuestion:"",contextPreviewGrant:"",questionContext:null,')
replace('function compactUI(){',(root/'scripts/memory-context-ui.js').read_text()+'\nfunction compactUI(){')
replace('function doAction(action,el){\n','function doAction(action,el){\n if(memoryContextAction(action))return;\n')
replace("state.originalMemoryHistory.push(content);","state.originalMemoryHistory.push(content);recordMemoryVersion('original',content);")
replace("state.generatedMemoryHistory.push(state.generatedMemoryDraft);","state.generatedMemoryHistory.push(state.generatedMemoryDraft);recordMemoryVersion('generated',state.generatedMemoryDraft);")
replace("state.generatedMemoryHistory.push(value('generated-memory-text'));","state.generatedMemoryHistory.push(value('generated-memory-text'));recordMemoryVersion('generated',value('generated-memory-text'));")
replace('state.generatedMemoryHistory=[];','state.generatedMemoryHistory=[];state.generatedMemoryCreatedAt=new Date().toISOString();state.memoryVersionLog.generated=[];',2)
replace("p.startsWith('notes')?'返回随手记':","p.startsWith('notes')?'返回随手记':p.startsWith('settings/agent-scope')?'返回上下文预览':")
replace("+'</section><div class=\"form-actions\">'+goButton('核对读取记录'","+'</section>'+questionContextPanel()+'<div class=\"form-actions\">'+goButton('核对读取记录'")

old=next(line for line in source.splitlines() if line.startswith('function memoriesPage(){'))
new='''function memoriesPage(){
 const kinds=memoryKinds().filter(memoryMatches),mode=state.memoryView||'current';
 const originalCard=!state.memoryDeleted&&memoryMatches('original')?'<article class="card section" data-memory-id="original"><div class="flex-spread"><h2>产品设计偏好</h2>'+tag('个人偏好','purple')+'</div><p id="memory-text" data-user-content>'+esc(originalMemoryText())+'</p>'+memoryMeta('original')+'<div class="actions card-foot">'+goButton('查看依据 · 产品评审记录','material/m1','text')+button('纠正这条记忆','correct-memory','','text')+button('继续整理','continue-memory','','text')+button('更多操作','memory-more','','text')+'</div><p class="small muted">'+mcText('继续整理会采用当前已保存的完整内容，保留当前记忆并生成补充建议。','Continue organizing uses the complete saved content, preserves this memory and produces additional suggestions.')+'</p></article>':'';
 const current=(memoryMatches('generated')?generatedMemoryCard():'')+originalCard;
 const absent=!memoryKinds().length?'<div class="empty"><h2>'+(state.dataState==='empty'?'还没有整理出的记忆':'这条记忆已删除')+'</h2><p>'+(state.materials.length?'原始资料仍保留，你可以重新选择资料整理。':'先保存资料，再从具体内容整理长期信息。')+'</p>'+(state.materials.length?button('从资料整理','manual-memory','','primary'):goButton('保存第一份资料','import','primary'))+'</div>':!kinds.length?memoryNoResults():'';
 return heading('记忆','从资料中整理的长期信息。每条都有依据，可以纠正或删除。',goButton('自动记忆设置','settings/plugins','subtle'))+'<div class="tabs"><button class="tab '+(mode==='current'?'active':'')+'" data-action="memory-current">当前记忆</button><button class="tab" data-action="memory-history">全部修改记录</button><button class="tab" data-action="manual-memory">从资料整理</button></div>'+memoryFilterPanel()+absent+(mode==='current'?current:memoryHistoricalView(kinds))+(state.memoryContinued?'<div class="notice good section">已基于当前记忆继续整理，保留已有纠正与出处。'+goButton('查看本次整理结果','activity/memory-continuation','text')+'</div>':'')+'<div class="section notice"><div>资料保留原文；记忆提取长期信息；洞察回顾阶段变化。'+goButton('生成一份阶段回顾','insights','text')+'</div></div>';
}'''
replace(old,new)
replace("+'</p><div class=\"actions card-foot\">'+state.memoryFrom.map","+'</p>'+memoryMeta('generated')+'<div class=\"actions card-foot\">'+state.memoryFrom.map")
old=next(line for line in source.splitlines() if line.startswith('function memoryTimeline(){'))
replace(old,"function memoryTimeline(){return memoryHistoryMarkup('generated');}")
old=next(line for line in source.splitlines() if line.startswith('function allMemoryHistory(){'))
replace(old,"function allMemoryHistory(){return memoryKinds().map(kind=>'<section class=\"card section\" data-history-memory=\"'+kind+'\"><h3>'+memoryName(kind)+'</h3>'+memoryHistoryMarkup(kind)+(kind==='original'?goButton('查看依据 · 产品评审记录','material/m1','text'):state.memoryFrom.map(id=>goButton(mcText('查看原文依据','View original evidence'),'material/'+id,'text')).join(''))+'</section>').join('')||'<p class=\"empty\">还没有记忆修改记录。</p>';}")

(root/'work/memory-context-r18.html').write_text(source)
(root/'reports/memory-context-r18-replacements.json').write_text(json.dumps(changes,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'replacements':len(changes),'bytes':len(source.encode()),'output':'work/memory-context-r18.html'}))
