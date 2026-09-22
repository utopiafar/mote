import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeStatusView} from '../dist/native-status.js';
const fixture=JSON.parse(readFileSync(new URL('../../../adapters/ui/fixtures/native-status.json',import.meta.url),'utf8'));
for(const row of fixture)test(row.name,()=>assert.deepEqual(nativeStatusView(row.facts),row.expected));
