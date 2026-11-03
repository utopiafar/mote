import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moteText } from '@mote/shared/i18n';
import { fileIndexCoverageLabel, fileIndexReadNote } from '../src/file-index-presentation';
import { materialState } from '../src/material-presentation';

// The DTO behind these cases carries processed-span metadata only: an empty
// parent text is not evidence that the body was dropped or is unreadable.
test('processed snapshot coverage never claims readable body text', () => {
  assert.equal(fileIndexCoverageLabel('full'), moteText('索引处理完成'));
  assert.equal(fileIndexReadNote(false), null);
  assert.equal(fileIndexReadNote(undefined), null);
});

test('an explicit read policy keeps the retained-body note when text is empty', () => {
  assert.equal(fileIndexCoverageLabel('full'), moteText('索引处理完成'));
  assert.match(fileIndexReadNote(true) ?? '', /允许中央保留提取出的完整正文/);
  assert.equal(fileIndexReadNote(true), ' · ' + moteText('允许中央保留提取出的完整正文，设备离线仍可查阅'));
});

test('partially processed or unprocessed indexes keep their own honest labels', () => {
  assert.equal(fileIndexCoverageLabel('lightweight'), moteText('部分索引就绪'));
  assert.equal(fileIndexCoverageLabel(undefined), moteText('已登记目录'));
});

test('material coverage completion reads as processing completion', () => {
  assert.equal(materialState('complete'), moteText('处理完成'));
  assert.equal(materialState('partial'), moteText('内容不完整'));
});
