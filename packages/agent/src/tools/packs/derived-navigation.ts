import {sourceContentTime} from '@mote/shared';
import {originalEvidenceReceipt} from '../../evidence-receipt.js';
import {CONTEXT_TOOLS} from '../../context-tools.js';
import {defineToolDescriptor, type ToolDescriptor, type ToolFields} from '../descriptor.js';
import {ContextToolError} from '../../tool-errors.js';
import {createHash} from 'node:crypto';
import type {HostSessionPort} from '../host-session.js';
import type {ContextRange, ContextRecord} from '../../context-contracts.js';
import {invalidPackArgument, scopedRange, type ReadPackInputs} from './materials.js';

/** Frozen run facts for navigation. The Host still checks every actual read. */
export interface DerivedNavigationInputs extends ReadPackInputs {
  readonly contextTime?: string;
  readonly incrementalEvidenceIds?: readonly string[];
  /** Parent chooses overview for a structured scheduled-insight run; text otherwise. */
  readonly defaultChangesView?: 'overview' | 'text';
}

function spec(name: string): readonly [string, string, ToolFields] {
  const entry = CONTEXT_TOOLS.find(([candidate]) => candidate === name);
  if (!entry) throw Error(`Missing context-tool schema for ${name}`);
  return entry as unknown as readonly [string, string, ToolFields];
}

function inScope(record: ContextRecord, scope: Readonly<ContextRange>): boolean {
  const at = sourceContentTime(record);
  return Number.isFinite(Date.parse(at)) && (!scope.deviceId || record.deviceId === scope.deviceId) &&
    (!scope.after || Date.parse(at) >= Date.parse(scope.after)) && (!scope.before || Date.parse(at) < Date.parse(scope.before));
}

export function createDerivedNavigationPack(input: DerivedNavigationInputs = {}): readonly ToolDescriptor[] {
  const timeZone = input.timeZone ?? 'UTC';
  const incremental = Object.freeze([...(input.incrementalEvidenceIds ?? [])]);
  const changePrefixes=new Map<string,string|null>();
  const defaultView = input.defaultChangesView ?? 'text';
  if (!['overview', 'text'].includes(defaultView)) throw invalidPackArgument('Invalid default changes view');
  const index = spec('context_index'), segment = spec('segments'), change = spec('changes');
  return Object.freeze([
    defineToolDescriptor({
      apiVersion: '1', name: 'context_index', version: '1', description: index[1], fields: index[2],
      kind: 'derived', exposure: 'catalog', requires: ['catalog'],
      parse(args) {
        if (args.path !== undefined && (typeof args.path !== 'string' || args.path.length > 100)) invalidPackArgument('Invalid context index arguments');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) invalidPackArgument('Invalid context index arguments');
        return args;
      },
      async execute(args, port) {
        port.assertCurrent();
        const value = await port.read('catalog', {
          ...scopedRange(port, args), path: args.path as string | undefined, query: args.query as string | undefined,
        }) ?? {entries: [], coverage: 'unavailable'};
        port.assertCurrent();
        return {source: 'untrusted_personal_context', data: value};
      },
    }),
    defineToolDescriptor({
      apiVersion: '1', name: 'segments', version: '1', description: segment[1], fields: segment[2],
      kind: 'derived', exposure: 'catalog', requires: ['segments'],
      parse(args) {
        if (args.id !== undefined && (typeof args.id !== 'string' || args.id.length > 1600)) invalidPackArgument('Invalid segment id');
        if (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) invalidPackArgument('Invalid segment query');
        return args;
      },
      async execute(args, port) {
        const scope = scopedRange(port, args);
        port.assertCurrent();
        const page = await port.read('segments', {...scope, id: args.id as string | undefined, query: args.query as string | undefined}) ?? {items: [], nextCursor: null};
        port.assertCurrent();
        if (!page || !Array.isArray(page.items) || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) invalidPackArgument('Invalid segments page');
        const items = page.items.filter(item => (!scope.deviceId || item.deviceId === scope.deviceId) &&
          (!scope.after || typeof item.firstAt === 'string' && Date.parse(item.firstAt) >= Date.parse(scope.after!)) &&
          (!scope.before || typeof item.lastAt === 'string' && Date.parse(item.lastAt) < Date.parse(scope.before!)));
        return {source: 'untrusted_personal_context', data: {...page, items}, pagination: {nextCursor: page.nextCursor}};
      },
    }),
    defineToolDescriptor({
      apiVersion: '1', name: 'changes', version: '1', description: change[1], fields: change[2],
      kind: 'derived', exposure: 'catalog', requires: ['evidence'],
      parse(args) {
        if (args.view !== undefined && !['overview', 'text'].includes(String(args.view))) invalidPackArgument('Invalid changes view');
        if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^(0|[1-9][0-9]*)$/.test(args.cursor))) invalidPackArgument('Invalid changes page');
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1)) invalidPackArgument('Invalid changes page');
        return args;
      },
      async execute(args, port) {
        const view = (args.view as 'overview' | 'text' | undefined) ?? defaultView;
        if (!['overview', 'text'].includes(view)) invalidPackArgument('Invalid changes view');
        const offset = args.cursor === undefined ? 0 : Number(args.cursor);
        const requested = Math.min(Number(args.limit ?? 30), 30);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(requested) || requested < 1) invalidPackArgument('Invalid changes page');
        if (!incremental.length) return {source: 'untrusted_personal_context', data: [], pagination: {nextCursor: null, totalCount: 0}};
        const scope = scopedRange(port, {});
        const pageLimit = Math.min(requested, scope.limit ?? requested);
        const cursorKey=(index:number)=>JSON.stringify([scope.after,scope.before,scope.deviceId,scope.source,scope.appId,scope.collection,index]);
        const expected=offset?changePrefixes.get(cursorKey(offset)):undefined;
        if(offset&&typeof expected!=='string')throw new ContextToolError('evidence_changed','The change cursor is unavailable; restart this listing.','stop');
        const prefix=createHash('sha256');let prefixVerified=offset===0;
        const verifyPrefix=()=>{
          if(!prefixVerified){
            if(prefix.copy().digest('hex')!==expected)throw new ContextToolError('evidence_changed','The visible changes changed; restart this listing.','stop');
            prefixVerified=true;
          }
        };
        const scoped:ContextRecord[]=[];
        let scanned=0,visible=0,hasMore=false;
        // The cursor counts visible records, not positions in the private Host
        // snapshot. Scan only as far as the next visible item and recheck each
        // page against the current reader and scope.
        while(scanned<incremental.length&&!hasMore){
          const selected=incremental.slice(scanned,scanned+pageLimit);scanned+=selected.length;
          port.assertCurrent();
          const records=await port.read('evidence',{...scope,ids:[...selected]});
          port.assertCurrent();
          if(!Array.isArray(records))invalidPackArgument('Changes evidence reader returned invalid records');
          const byId=new Map((records as ContextRecord[]).filter(record=>selected.includes(record.id)&&inScope(record,scope)).map(record=>[record.id,record]));
          for(const id of selected){
            const record=byId.get(id);if(!record)continue;
            if(visible===offset)verifyPrefix();
            if(visible>=offset){if(scoped.length===pageLimit){hasMore=true;break;}scoped.push(record);}
            prefix.update(JSON.stringify([record.id,originalEvidenceReceipt(record,0,600,timeZone).evidenceFingerprint])+'\n');
            visible++;
          }
        }
        if(!prefixVerified){
          if(visible!==offset)throw new ContextToolError('evidence_changed','The visible changes changed; restart this listing.','stop');
          verifyPrefix();
        }
        if(scoped.length){
          // Looking ahead may take multiple reads. Revalidate the page after
          // that work so a withdrawn or changed first record is never sent.
          const fresh=await port.read('evidence',{...scope,ids:[...new Set(scoped.map(record=>record.id))]});
          port.assertCurrent();
          if(!Array.isArray(fresh))invalidPackArgument('Changes evidence reader returned invalid records');
          const current=new Map((fresh as ContextRecord[]).filter(record=>inScope(record,scope)).map(record=>[record.id,record]));
          if(scoped.some(record=>!current.has(record.id)||JSON.stringify(originalEvidenceReceipt(record,0,600,timeZone))!==JSON.stringify(originalEvidenceReceipt(current.get(record.id)!,0,600,timeZone))))
            throw new ContextToolError('evidence_changed','A change was withdrawn or revised before disclosure.','stop');
        }
        if(hasMore){
          const key=cursorKey(offset+scoped.length),fingerprint=prefix.copy().digest('hex'),previous=changePrefixes.get(key);
          changePrefixes.set(key,previous===undefined||previous===fingerprint?fingerprint:null);
        }
        const data = view === 'overview'
          ? scoped.map(record => ({
            id: record.id, capturedAt: record.capturedAt, contentAt: sourceContentTime(record),
            appName: record.appName, sourceType: record.sourceType, characters: String(record.ocrText ?? '').length,
          }))
          : scoped.map(record => originalEvidenceReceipt(record, 0, 600, timeZone));
        return {source: 'untrusted_personal_context', data, pagination: {
          nextCursor: hasMore ? String(offset + scoped.length) : null,
          ...(!hasMore ? {totalCount: visible} : {}),
        }};
      },
    }),
  ]);
}
