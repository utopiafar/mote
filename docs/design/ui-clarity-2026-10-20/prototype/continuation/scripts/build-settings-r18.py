from pathlib import Path
import hashlib,json
root=Path(__file__).resolve().parents[1]
source=(root/'dist/r17.html').read_text()
s=source
patches=[]
def change(label,before,after):
 global s
 count=s.count(before)
 if count!=1:raise ValueError(f'{label}: expected one occurrence, got {count}: {before[:160]}')
 s=s.replace(before,after,1)
 patches.append({'label':label,'before':before,'after':after})
change('Independent defaults before snapshot',
 'const initialDefaults=JSON.parse(JSON.stringify(state));',
 "Object.assign(state,{accountServiceUrl:'https://mote.example.invalid',accountNodeName:'Mote Central · Demo',accountRetention:'session',accountRetentionDraft:null,accountRetentionSaved:false,importImageScheme:'default',importImageDrafts:{}});\nconst initialDefaults=JSON.parse(JSON.stringify(state));")
translations=json.loads((root/'scripts/settings-r18-translations.json').read_text())
helpers=(root/'scripts/settings-r18-additions.js').read_text()
change('Independent completion helpers and English dictionary','// ENGLISH_COMPLETION_END','// ENGLISH_COMPLETION_END\nObject.assign(englishLabels,'+json.dumps(translations,ensure_ascii=False,separators=(',',':'))+');\n'+helpers)
change('Account service and retention entry',
 '当前账号的资料、待同步笔记和草稿分别保留。</p></div><section class="section">',
 '当前账号的资料、待同步笔记和草稿分别保留。</p></div>\'+accountServiceSettings()+\'<section class="section">')
change('Independent settings action dispatch',
 'accountAction(action)||noteAction(action,el)',
 'settingsCompletionAction(action,el)||accountAction(action)||noteAction(action,el)')
change('Import detail route', 'function importPage(){\n', "function importPage(){\n if(state.page.startsWith('import/details/'))return importDetailsPage();\n")
change('Platform-specific local file label',
 '''data-origin="'+v+'">'+v+'</button>''',
 '''data-origin="'+v+'">'+importOriginLabel(v)+'</button>''')
change('Current import image plan field',
 '''<small>不确定格式时可以保持自动识别。</small></label></div><div class="form-actions">''',
 '''<small>不确定格式时可以保持自动识别。</small></label>'+importImageChoice('import-image-scheme',state.importImageScheme)+'</div><div class="form-actions">''')
change('Preserve original title in completion notice',
 '''<p>'+esc(state.importName||state.importFile)+' 已可阅读。</p>''',
 '''<p><span data-user-content>'+esc(state.importName||state.importFile)+'</span> <span>已可阅读。</span></p>''')
change('Completed import exposes its saved image plan',
 '''<p>'+esc(state.importSave)+' · '+esc(state.importParser)+'</p><div class="actions">''',
 '''<p>'+esc(state.importSave)+' · '+esc(state.importParser)+'</p><p><span>图片处理方案</span> · <span>'+importImagePlanLabel(currentImportImagePlan())+'</span></p><div class="actions">''')
change('Current import opens its own details',
 "goButton('查看这次导入记录','imports','subtle')",
 "goButton('查看这次导入记录','import/details/batch-current-'+state.importCounter,'subtle')")
change('New imports start with default image plan',
 "if(action==='new-import'){state.importDone=false;state.importFile='';state.importName='';return go('import');}",
 "if(action==='new-import'){state.importDone=false;state.importFile='';state.importName='';state.importImageScheme='default';return go('import');}")
change('Capture selected image scheme at submission',
 "state.importParser=value('import-parser');state.importDone=true;",
 "state.importParser=value('import-parser');state.importImageScheme=value('import-image-scheme')||'default';state.importDone=true;")
change('Use current preview device for local import metadata',
 "device:state.importOrigin==='中央目录'?'工作台':'网页',origin:state.importOrigin==='中央目录'?state.importFile:state.importOrigin+' / '+state.importFile",
 "device:state.importOrigin==='中央目录'?'工作台':importLocalDevice(),origin:state.importOrigin==='中央目录'?state.importFile:(state.surface==='android'?'Android':state.surface==='mac'?'Mac':'Web')+' / '+state.importFile")
change('Snapshot each import configuration separately',
 "name:state.importName,phase:'done',materialId:state.importedId,count:1",
 "name:state.importName,phase:'done',materialId:state.importedId,count:1,sourceFile:state.importFile,saveMode:state.importSave,parser:state.importParser,imageScheme:state.importImageScheme,device:state.importOrigin==='中央目录'?'工作台':importLocalDevice()")
change('All import records expose details',
 "+button('删除这次导入','delete-import','data-id=\"'+b.id+'\"','text')",
 "+goButton('导入详情与图片方案','import/details/'+b.id,'subtle')+button('删除这次导入','delete-import','data-id=\"'+b.id+'\"','text')")
change('Reading result links back to its import image plan',
 '''+'</div><section class="evidence-box"><h2>来源与原始资料</h2>''',
 '''+'</div>'+importedMaterialPlan(m)+'<section class="evidence-box"><h2>来源与原始资料</h2>''')
start=s.index('function applicationPage(){');end=s.index('\nfunction ',start+1)
change('Application activity uses measured sample duration shares',s[start:end],"function applicationPage(){return applicationSamplingPage();}")
(root/'work/settings-r18.html').write_text(s)
(root/'reports/settings-r18-replacements.json').write_text(json.dumps(patches,ensure_ascii=False,indent=2)+'\n')
result={'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'candidate_sha256':hashlib.sha256(s.encode()).hexdigest(),'patches':len(patches),'translation_entries':len(translations),'candidate_bytes':len(s.encode())}
(root/'reports/settings-r18-metadata.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
