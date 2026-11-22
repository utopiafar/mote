import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import postcss from 'postcss';

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
