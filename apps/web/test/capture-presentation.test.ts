import test from 'node:test';
import assert from 'node:assert/strict';
import {captureOcrState} from '@mote/shared';
import {captureDateRange, localDateInput, ocrPresentation} from '../src/capture-presentation';

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
