import {readFileSync,writeFileSync} from 'node:fs';
import {uiRulesSchema,uiSnapshotSchema,extractUiPage} from '../packages/shared/dist/ui-page.js';
const [command,input,rulesFile,platform='android']=process.argv.slice(2);
if(command==='replay'){
 const snapshot=uiSnapshotSchema.parse(JSON.parse(readFileSync(input,'utf8')));
 const rules=uiRulesSchema.parse(JSON.parse(readFileSync(rulesFile??'adapters/ui/builtin.json','utf8')));
 if(!['android','macos'].includes(platform))throw Error('Invalid platform');
 console.log(JSON.stringify(extractUiPage(snapshot,rules,platform)??{status:'unsupported'},null,2));
}else if(command==='generate'){
 const source=readFileSync('adapters/ui/builtin.json','utf8');uiRulesSchema.parse(JSON.parse(source));
 writeFileSync('packages/shared/src/ui-builtins.ts',"// Generated from adapters/ui/builtin.json by scripts/ui-adapters.mjs.\nimport {uiRulesSchema} from './ui-page.js';\nexport const builtinUiRules=uiRulesSchema.parse("+source.trim()+");\n");
}else throw Error('Usage: node scripts/ui-adapters.mjs replay SNAPSHOT [RULES] [android|macos] | generate');
