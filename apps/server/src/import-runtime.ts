import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {importRecordSchema} from './import-record.js';
import type {ImportPreparation} from './imports.js';
import {privateFile} from './private-storage.js';

/** Generate a portable helper with explicit dependency locations for this import workspace. */
export function prepareImportInput(input:ImportPreparation){
  let helper=readFileSync(new URL('./import-parser.mjs',import.meta.url),'utf8');
  const dependencies:Record<string,string>={
    '__DOCUMENT_DECODER__':'@mote/shared/document-decoder','__MOTE_SHARED__':'@mote/shared','__ZOD__':'zod','__MAMMOTH__':'mammoth',
    '__PDFJS__':'pdfjs-dist/legacy/build/pdf.mjs','__PDF_WORKER__':'pdfjs-dist/legacy/build/pdf.worker.mjs',
    '__EXCELJS__':'exceljs','__YAML__':'yaml','__FFLATE__':'fflate',
  };
  for(const [placeholder,specifier]of Object.entries(dependencies))helper=helper.replaceAll(JSON.stringify(placeholder),JSON.stringify(import.meta.resolve(specifier)));
  helper=helper.replaceAll('"__IMPORT_CONTRACT__"',JSON.stringify(new URL('./import-disposition-validation.mjs',import.meta.url).href));
  helper=helper.replaceAll('"__PDF_STANDARD_FONTS__"',JSON.stringify(join(dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))),'standard_fonts')+sep));
  const paths={__MOTE_INPUT_PATHS__:input.inputPaths,__MOTE_HOST_ATTACHMENT_PATHS__:(input.hostMedia??[]).map(item=>item.path)};
  helper=helper.replace(/__MOTE_(?:INPUT_PATHS|HOST_ATTACHMENT_PATHS)__/g,placeholder=>JSON.stringify(paths[placeholder as keyof typeof paths]));
  const helperPath=join(input.workspace,'mote-files.mjs');privateFile(helperPath,true);writeFileSync(helperPath,helper,{mode:0o600});
  const manifestSchema=zodToJsonSchema(importRecordSchema,{name:'ImportRecord',$refStrategy:'root'});
  const schemaPath=join(input.workspace,'manifest-schema.json');privateFile(schemaPath,true);writeFileSync(schemaPath,JSON.stringify(manifestSchema,null,2)+'\n',{mode:0o600});
  return {...input,helperPath,manifestSchema,schemaPath};
}
