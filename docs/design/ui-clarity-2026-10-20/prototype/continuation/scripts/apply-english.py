from pathlib import Path
import json,re
root=Path(__file__).resolve().parents[1]
inventory=json.loads((root/'reports/english-inventory.json').read_text())['unique']
translations={}
for row in (root/'scripts/english-translations.tsv').read_text().splitlines():
    if not row.strip():continue
    key,value=row.split('\t',1)
    translations[inventory[int(key)]['text']]=value
extra=root/'scripts/english-extra.json'
actions=root/'reports/english-actions-inventory.json'
action_labels=root/'scripts/english-action-translations.tsv'
if actions.exists() and action_labels.exists():
    action_rows=json.loads(actions.read_text())['unique']
    for row in action_labels.read_text().splitlines():
        if not row.strip():continue
        key,value=row.split('\t',1)
        record=action_rows[int(key)]
        translations[record.get('originalText',record['text'])]=value
if extra.exists():translations.update(json.loads(extra.read_text()))
p=root/'work/interface-states.html'
s=p.read_text()
start=s.index('// ENGLISH_COMPLETION_START') if '// ENGLISH_COMPLETION_START' in s else s.index('function localizeUI()')
end=s.index('// ENGLISH_COMPLETION_END',start)+len('// ENGLISH_COMPLETION_END') if '// ENGLISH_COMPLETION_END' in s else s.index('\n',start)
runtime=(root/'scripts/english-runtime.js').read_text()
block='// ENGLISH_COMPLETION_START\nObject.assign(englishLabels,'+json.dumps(translations,ensure_ascii=False,separators=(',',':'))+');\n'+runtime+'\n// ENGLISH_COMPLETION_END'
p.write_text(s[:start]+block+s[end:])
print(json.dumps({'translations':len(translations),'candidate':str(p)}))
