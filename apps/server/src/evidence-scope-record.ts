import type {CaptureRecord} from '@mote/shared';
import type {Store} from './store.js';

// Read scope metadata only: expanding a derived artifact must not materialize all original text/images.
const field=(path:string)=>`json_extract(json,'$.${path}')`;
const projection=`json_object(
 'id',id,'deviceId',device_id,'capturedAt',captured_at,
 'source',${field('source')},'appId',${field('appId')},
 'privacy',json_object('collection',${field('privacy.collection')}),
 'ocr',json_object('status',${field('ocr.status')}),
 'stateSeries',json_object('samples',json_array(json_object('at',${field('stateSeries.samples[#-1].at')}))),
 'provenance',json_object('sourceId',${field('provenance.sourceId')},'document',json_object(
  'timeBasis',${field('provenance.document.timeBasis')},'occurredAt',${field('provenance.document.occurredAt')},'recordedAt',${field('provenance.document.recordedAt')},'coding',${field('provenance.document.coding')})),
 'metadata',json_object('media',json_object('sessions',json(coalesce((SELECT json_group_array(json_object('appId',json_extract(value,'$.appId'))) FROM json_each(captures.json,'$.metadata.media.sessions')),'[]'))))
)`;
export function scopeRecord(store:Store,id:string):CaptureRecord|undefined {
 const row=store.db.prepare(`SELECT ${projection} AS scope FROM captures WHERE id=?`).get(id);
 return row?JSON.parse(String(row.scope)) as CaptureRecord:undefined;
}
