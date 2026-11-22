import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import postcss from 'postcss';
import ts from 'typescript';

const sourceDirectories=[
  new URL('../src/',import.meta.url),
  new URL('../../desktop/src/',import.meta.url),
];

test('Web and Mac styles do not draw character icons with CSS content',()=>{
  const glyphs: string[]=[];
  for(const url of sourceDirectories){
    const directory=fileURLToPath(url);
    for(const file of readdirSync(directory,{recursive:true}).filter(file=>file.endsWith('.css'))){
      const stylesheet=join(directory,file);
      const root=postcss.parse(readFileSync(stylesheet,'utf8'),{from:stylesheet});
      root.walkDecls('content',declaration=>{
        const literal=/^(['"])(.*?)\1(?:\s|\/|$)/u.exec(declaration.value)?.[2];
        if(literal===undefined)return;
        const text=literal.replace(/\\([0-9a-f]{1,6})\s?/giu,(_match,hex:string)=>{
          const codePoint=Number.parseInt(hex,16);
          return codePoint>0x10ffff?'\ufffd':String.fromCodePoint(codePoint);
        }).trim();
        if([...text].length===1&&!/[\p{L}\p{N}]/u.test(text)){
          glyphs.push(`${stylesheet}:${declaration.source?.start?.line} ${text}`);
        }
      });
    }
  }
  assert.deepEqual(glyphs,[]);
});

test('disclosures styled with a chevron keep a Lucide icon in their summary',()=>{
  const webSource=fileURLToPath(sourceDirectories[0]);
  const disclosureClasses=new Set([
    'import-create-advanced',
    'memory-rhythm-advanced',
    'owner-disclosure',
    'plugin-advanced',
    'settings-directory-advanced',
  ]);
  const omissions: string[]=[];
  let summaries=0;
  for(const file of readdirSync(webSource,{recursive:true}).filter(file=>file.endsWith('.tsx'))){
    const tree=ts.createSourceFile(file,readFileSync(join(webSource,file),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
    function visit(node: ts.Node){
      if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(tree)==='details'){
        const classes=node.openingElement.attributes.properties.find(property=>ts.isJsxAttribute(property)&&property.name.getText(tree)==='className');
        if(classes&&ts.isJsxAttribute(classes)&&classes.initializer&&ts.isStringLiteral(classes.initializer)
          &&classes.initializer.text.split(/\s+/).some(name=>disclosureClasses.has(name))){
          summaries++;
          const summary=node.children.find((child): child is ts.JsxElement=>ts.isJsxElement(child)&&child.openingElement.tagName.getText(tree)==='summary');
          const icon=summary?.children.some(child=>ts.isJsxSelfClosingElement(child)&&child.tagName.getText(tree)==='ChevronRight');
          if(!icon)omissions.push(`${file}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1}`);
        }
      }
      ts.forEachChild(node,visit);
    }
    visit(tree);
  }
  assert.ok(summaries>0,'The test checks the actual disclosure components');
  assert.deepEqual(omissions,[]);
});
