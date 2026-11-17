import type {ServerConfiguration} from '@mote/shared';
export type DraftValues = Record<string,string>;

const displayScale=(key:string)=>key==='storage.maxExportBytes'?1048576:key==='connectors.syncIntervalMs'?1000:1;
const valueAt=(value:unknown,path:string):unknown=>path.split('.').reduce<unknown>((current,part)=>current&&typeof current==='object'&&!Array.isArray(current)?(current as Record<string,unknown>)[part]:undefined,value);
function fields(config:ServerConfiguration) {
  return config.domains.flatMap(domain=>domain.fields.filter(field=>!field.sensitive&&!field.path.includes('*')
    &&!domain.fields.some(parent=>parent.sensitive&&field.path.startsWith(parent.path+'.'))).map(field=>({
      key:domain.id+'.'+field.path,id:domain.id,path:field.path,
      value:valueAt(domain.saved,field.path)??valueAt(domain.effective,field.path),
    }))).filter(field=>typeof field.value==='string'||typeof field.value==='number'||typeof field.value==='boolean'
      ||Array.isArray(field.value)&&field.value.every(value=>typeof value==='string'));
}
/** The editor uses registered canonical domain paths and saved restart-pending choices. */
export function savedValues(config:ServerConfiguration):DraftValues {
  return Object.fromEntries(fields(config).map(({key,value})=>[key,typeof value==='number'?String(value/displayScale(key))
    :Array.isArray(value)?value.join(','):typeof value==='boolean'?value?'1':'0':String(value)]));
}
/** Submit only edited registered raw paths; never echo configured-status booleans for secrets. */
export function configurationPatches(config:ServerConfiguration,changes:DraftValues):{id:string;value:Record<string,unknown>}[] {
  const registered=new Map(fields(config).map(field=>[field.key,field])),domains=new Map<string,Record<string,unknown>>();
  for(const [key,draft] of Object.entries(changes)) {
    const field=registered.get(key);
    if(!field)throw new Error('Field is not editable');
    const path=field.path.split('.');
    if(path.some(part=>!part||['__proto__','constructor','prototype','*'].includes(part)))throw new Error('Field is not editable');
    let value:unknown=draft;
    if(typeof field.value==='boolean')value=draft==='1';
    else if(Array.isArray(field.value))value=draft.split(',').map(item=>item.trim()).filter(Boolean);
    else if(typeof field.value==='number') {
      const number=Number(draft);
      if(!draft.trim()||!Number.isFinite(number))throw new Error('Invalid numeric configuration value');
      value=number*displayScale(key);
    }
    const patch=domains.get(field.id)??{};domains.set(field.id,patch);
    let target=patch;
    for(const part of path.slice(0,-1))target=(target[part]??={}) as Record<string,unknown>;
    target[path.at(-1)!]=value;
  }
  return [...domains].map(([id,value])=>({id,value}));
}
