import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOcrState} from '@mote/shared';
import {captureDateRange, evidencePresentation, localDateInput, ocrPresentation} from '../src/capture-presentation';

test('OCR distinguishes deferred, failed and completed-with-no-text screenshots without guessing from an empty body', () => {
  assert.equal(ocrPresentation({status:'pending',reason:'charging'}, '').label, 'OCR 待充电');
  assert.equal(ocrPresentation({status:'pending'}, '').label, 'OCR 待处理');
  assert.equal(ocrPresentation({status:'completed'}, '').label, 'OCR 未识别到文字');
  assert.equal(ocrPresentation({status:'completed'}, '合成文字').label, 'OCR 已完成');
  assert.equal(ocrPresentation({status:'failed'}, '').label, 'OCR 失败');
  assert.equal(ocrPresentation({status:'disabled'}, '').label, 'OCR 已关闭');
  assert.equal(ocrPresentation(captureOcrState({source:'screen',ocrText:''}), '').label, 'OCR 状态未知');
  assert.equal(ocrPresentation(captureOcrState({source:'note',ocrText:'手写笔记'}), '手写笔记').label, '无需 OCR');
  assert.equal(captureOcrState({source:'screen',ocrText:'旧版保留的识别结果'}).status, 'completed');
});

test('day filters use local midnight across both daylight-saving boundaries', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const spring = captureDateRange('2026-03-08','2026-03-08');
    const autumn = captureDateRange('2026-11-01','2026-11-01');
    assert.equal(Date.parse(spring.before!) - Date.parse(spring.after!), 23 * 60 * 60 * 1000);
    assert.equal(Date.parse(autumn.before!) - Date.parse(autumn.after!), 25 * 60 * 60 * 1000);
    assert.equal(localDateInput(new Date(spring.after!)), '2026-03-08');
    assert.deepEqual(captureDateRange('',''), {});
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('deduplicated records explain that no image or OCR text was saved', () => {
  const display = ocrPresentation({status:'disabled'}, '', true);
  assert.equal(display.label, '图片去重 · 仅元数据');
  assert.match(display.description, /未保存图片或 OCR 文本/);
  assert.doesNotMatch(display.description, /截图仍可查看/);
});

test('imported file records keep their archived-original controls separate from device file processing', () => {
  const imported = evidencePresentation({id:'import-record',source:'file',platform:'import',provenance:{sourceId:'import-source',externalId:'note-1',revision:'1',layer:'snapshot',deleted:false,document:{fileId:'archived-original',path:'export/note.md'}}});
  assert.equal(imported.nativeFile, undefined);
  assert.equal(imported.textLabel, '原始文本');
  assert.match(imported.deleteDescription, /导入仍保留原始文件/);
  assert.doesNotMatch(imported.deleteDescription, /删除中央文件归档/);
  const metadata = evidencePresentation({id:'device-file',source:'file',platform:'android'});
  assert.deepEqual(metadata.nativeFile, {captureId:'device-file'});
  assert.equal(metadata.textLabel, '文件元信息');
  assert.match(metadata.deleteDescription, /来源设备上的原文件保留/);
});

test('native transcript citations open their parent file at the cited offset', () => {
  const segment = evidencePresentation({id:'chunk',source:'file',platform:'android',fileEvidence:{captureId:'parent',revision:'v2',artifactId:'transcript',chunkId:'chunk',startMs:12500,endMs:16750,speaker:'S1'}});
  assert.deepEqual(segment.nativeFile, {captureId:'parent',startMs:12500});
  assert.equal(segment.textLabel, '转写片段');
  assert.match(segment.deleteDescription, /依赖记忆/);
});
