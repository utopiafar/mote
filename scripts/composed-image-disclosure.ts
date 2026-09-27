/** Mechanical accounting for image harnesses; no fixture prose or model calls. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';

export type ImageDisclosureProtocol='one-original'|'bounded-views';
type Selection={id:string;attachmentId?:string;view:'image'|'metadata';expectedImageSha256?:string;region:{x:number;y:number;width:number;height:number}|null};
type Json=Record<string,any>;
type Metadata=Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>;
type Read={selection:Selection;kind:'metadata'|'payload'|'repeat';imageView?:Json;firstSelection?:Selection;firstImageView?:Json;imageBudget?:Json;hostBudget?:Json;payloadKey?:string;mimeType?:string;encodedCharacters?:number};
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function imageMime(format:string|undefined){
 const mime=format==='png'?'image/png':format==='jpeg'?'image/jpeg':format==='webp'?'image/webp':undefined;
 assert.ok(mime,'Unsupported original image format');return mime;
}
// libvips does not expose APNG frame count. Inspect only the bounded file structure.
function pngPages(bytes:Buffer){
 let offset=8,declared=1,frames=0,animation=false;
 while(offset+12<=bytes.length){const length=bytes.readUInt32BE(offset),end=offset+12+length;assert.ok(end<=bytes.length,'Invalid PNG chunk bounds');const kind=bytes.toString('ascii',offset+4,offset+8);
  if(kind==='acTL'){assert.ok(!animation&&length===8,'Invalid PNG animation header');declared=bytes.readUInt32BE(offset+8);assert.ok(declared>0);animation=true;}
  if(kind==='fcTL'){assert.equal(length,26);frames++;}if(kind==='IEND')return Math.max(declared,frames);offset=end;
 }throw Error('Invalid PNG frame structure');
}
const keys=(value:Json,allowed:string[])=>assert.ok(Object.keys(value).every(key=>allowed.includes(key)),'Unknown image protocol field');
function selection(raw:Json):Selection{
 assert.ok(raw&&typeof raw==='object'&&!Array.isArray(raw));keys(raw,['id','attachmentId','view','expectedImageSha256','region']);
 assert.ok(typeof raw.id==='string'&&raw.id.length>0);assert.ok(raw.attachmentId===undefined||typeof raw.attachmentId==='string');
 const view=raw.view??'image';assert.ok(view==='image'||view==='metadata');
 assert.ok(raw.expectedImageSha256===undefined||/^[a-f0-9]{64}$/.test(raw.expectedImageSha256));
 let region:Selection['region']=null;
 if(raw.region!==undefined){keys(raw.region,['x','y','width','height']);for(const name of ['x','y','width','height'])assert.ok(Number.isSafeInteger(raw.region[name]),'Region coordinates must be integers');
  const {x,y,width,height}=raw.region;assert.ok(x>=0&&y>=0&&width>0&&height>0&&width<=2048&&height<=2048,'Region bounds exceed the public contract');region={x,y,width,height};assert.ok(raw.expectedImageSha256&&view==='image');}
 return {id:raw.id,...(raw.attachmentId===undefined?{}:{attachmentId:raw.attachmentId}),view,...(raw.expectedImageSha256===undefined?{}:{expectedImageSha256:raw.expectedImageSha256}),region};
}
const sameSelection=(a:Selection,b:Selection)=>assert.deepEqual(a,b,'Image selection attribution changed');
const viewWithoutDelivery=(view:Json)=>{const {delivery:_,...identity}=view;return identity;};

/** This checks observed tool bytes after a read. It never selects a region or adds model input. */
export class ComposedImageDisclosure {
 private readonly bytes:Buffer;
 private readonly originalHash:string;
 private readonly originalMetadata:Promise<Metadata>;
 private readonly outputs=new Map<string,Promise<Buffer>>();
 private readonly first=new Map<string,Read>();
 private readonly reads:Read[]=[];
 private failed?:string;
 private adapterVerified=false;
 constructor(readonly protocol:ImageDisclosureProtocol,original:Buffer,readonly width:number,readonly height:number){
  assert.ok(protocol==='one-original'||protocol==='bounded-views');assert.ok(original.length>0&&original.length<=8*1024*1024,'Original exceeds the fixed byte quota');this.bytes=Buffer.from(original);this.originalHash=digest(this.bytes);this.originalMetadata=sharp(this.bytes,{limitInputPixels:40_000_000}).metadata();
 }
 private async originalIdentity(){
  const original=await this.originalMetadata;assert.equal(original.width,this.width);assert.equal(original.height,this.height);
  return {sha256:this.originalHash,width:this.width,height:this.height,mimeType:imageMime(original.format),orientation:original.orientation??1,pages:original.format==='png'?pngPages(this.bytes):original.pages??1};
 }
 private async outputMime(selected:Selection){return selected.region?'image/png':(await this.originalIdentity()).mimeType;}
 private expectedOutput(selected:Selection){
  const key=JSON.stringify(selected.region);let value=this.outputs.get(key);
  if(!value){value=selected.region?sharp(this.bytes).extract({left:selected.region.x,top:selected.region.y,width:selected.region.width,height:selected.region.height}).toColourspace('srgb').png().toBuffer():Promise.resolve(this.bytes);this.outputs.set(key,value);}return value;
 }
 private async verifyView(selected:Selection,view:Json,kind:Read['kind']){
  assert.ok(view&&typeof view==='object','A successful bounded read requires imageView');keys(view,['original','coordinateSpace','region','transform','viewId','output','id','attachmentId','delivery']);
  const original=await this.originalIdentity();assert.deepEqual(view.original,original,'Unknown or changed original image');
  if(selected.region)assert.equal(original.pages,1,'Multi-frame regions are unsupported');
  assert.equal(view.id,selected.id);assert.equal(view.attachmentId,selected.attachmentId);assert.equal(view.coordinateSpace,'encoded-raster-pixels-v1');assert.deepEqual(view.region,selected.region);
  const transform=kind==='metadata'?'metadata@1':selected.region?'crop-encoded-raster-png@1':'original-bytes@1';assert.equal(view.transform,transform,'Unknown image transform');
  assert.equal(view.viewId,digest(JSON.stringify([this.originalHash,'encoded-raster-pixels-v1',selected.region,transform])));
  assert.equal(view.delivery,kind==='metadata'?'metadata':kind==='repeat'?'already_disclosed':'pending');
  if(kind==='metadata'){assert.equal(view.output,undefined);return;}
  const expected=await this.expectedOutput(selected);assert.ok(expected.length<=8*1024*1024,'Output exceeds the fixed byte quota');
  assert.deepEqual(view.output,{sha256:digest(expected),width:selected.region?.width??this.width,height:selected.region?.height??this.height,mimeType:await this.outputMime(selected),sizeBytes:expected.length},'Output identity/geometry does not match the requested original pixels');
 }
 async observeSuccessfulRead(raw:Json,result:Json){
  try{
   assert.equal(this.failed,undefined,'Image accounting already failed');const selected=selection(raw);
   assert.equal(result.source,'untrusted_personal_context');assert.equal(result.id,selected.id);assert.equal(result.attachmentId,selected.attachmentId);
   if(selected.expectedImageSha256!==undefined)assert.equal(selected.expectedImageSha256,this.originalHash,'Request selected an unknown original');
   if(selected.region)assert.ok(selected.region.x+selected.region.width<=this.width&&selected.region.y+selected.region.height<=this.height,'Crop exceeds original raster');
   if(this.protocol==='one-original'){assert.equal(selected.view,'image','Legacy mode does not accept metadata as an image read');assert.equal(selected.region,null,'Legacy mode requires the unchanged original');}
   const kind:Read['kind']=selected.view==='metadata'?'metadata':result.image?'payload':'repeat';
   if(this.protocol==='bounded-views'||result.imageView)await this.verifyView(selected,result.imageView,kind);
   const row:Read={selection:selected,kind,...(result.imageView?{imageView:structuredClone(result.imageView)}:{})};
   if(kind==='metadata'){assert.equal(result.image,undefined);assert.equal(result.imageDisclosure,undefined);assert.equal(result.imageDelivery,undefined);}
   else if(kind==='payload'){
    assert.equal(result.imageDisclosure,undefined);const mimeType=await this.outputMime(selected);assert.equal(result.image.mimeType,mimeType);assert.ok(typeof result.image.data==='string'&&result.image.data.length>0);
    const actual=Buffer.from(result.image.data,'base64');assert.ok(actual.toString('base64')===result.image.data,'Invalid encoded image');assert.ok(actual.length<=8*1024*1024);
    const expected=await this.expectedOutput(selected);assert.equal(digest(actual),digest(expected),'Actual payload bytes do not match the frozen original/view');
    const geometry=await sharp(actual).metadata();assert.equal(imageMime(geometry.format),mimeType);assert.equal(geometry.width,selected.region?.width??this.width);assert.equal(geometry.height,selected.region?.height??this.height);
    const key=mimeType+':'+digest(actual);assert.ok(!this.first.has(key),'An identical payload was appended again');assert.ok(this.first.size<(this.protocol==='one-original'?1:4),'Unique payload quota exceeded');
    assert.ok(typeof result.imageDelivery==='string'&&/^[a-f0-9]{48}$/.test(result.imageDelivery),'Missing local delivery reservation');
    row.payloadKey=key;row.mimeType=mimeType;row.encodedCharacters=result.image.data.length;this.first.set(key,row);
   }else{
    assert.equal(result.image,undefined);assert.equal(result.imageDelivery,undefined);assert.equal(result.imageDisclosure?.status,'already_disclosed','Unclassified successful image read');
    const expected=await this.expectedOutput(selected),mimeType=await this.outputMime(selected),key=mimeType+':'+digest(expected);assert.equal(result.imageDisclosure.sha256,digest(expected));assert.equal(result.imageDisclosure.mimeType,mimeType);
    const first=this.first.get(key);assert.ok(first,'Repeat refers to an image that this query never received');sameSelection(selection(result.imageDisclosure.firstSelection),first.selection);
    if(this.protocol==='bounded-views'){assert.ok(result.imageDisclosure.firstImageView);assert.deepEqual(viewWithoutDelivery(result.imageDisclosure.firstImageView),viewWithoutDelivery(first.imageView!));assert.equal(result.imageDisclosure.firstImageView.delivery,'prepared');}
    row.payloadKey=key;row.mimeType=mimeType;row.firstSelection=selection(result.imageDisclosure.firstSelection);if(result.imageDisclosure.firstImageView)row.firstImageView=structuredClone(result.imageDisclosure.firstImageView);
   }
   if(this.protocol==='bounded-views'){assert.deepEqual(result.imageBudget,{remainingPayloads:4-this.first.size,maxRegionSide:2048,maxOutputBytes:8*1024*1024});assert.ok(Number.isSafeInteger(result.hostBudget?.remainingCalls)&&result.hostBudget.remainingCalls>=0);assert.ok(Number.isSafeInteger(result.hostBudget?.remainingCharactersBeforeResult)&&result.hostBudget.remainingCharactersBeforeResult>=0);assert.equal(result.hostBudget.unit,'utf16_characters');row.imageBudget=structuredClone(result.imageBudget);row.hostBudget=structuredClone(result.hostBudget);}
   this.reads.push(row);
  }catch(error){this.failed=error instanceof Error?error.message:String(error);throw error;}
 }
 /** Reconcile every successful adapter event and QueryResult trace, including aliases without attachmentId. */
 verifyModelDelivery(toolTrace:Json[],events:Json[]){
  assert.equal(this.failed,undefined,'A successful read failed image protocol accounting');
  assert.ok(this.first.size>=1,'Metadata alone is not image delivery');assert.ok(this.first.size<=(this.protocol==='one-original'?1:4));
  const reads=toolTrace.filter(event=>event.tool==='read_image'),adapters=events.filter(event=>event.type==='tool.completed'&&event.tool==='read_image'&&event.status==='succeeded');
  assert.equal(reads.length,this.reads.length,'Unaccounted successful read_image trace');assert.equal(adapters.length,this.reads.length,'Unaccounted successful adapter image result');
  for(const [i,row] of this.reads.entries()){
   sameSelection(selection(reads[i].arguments),row.selection);assert.equal(reads[i].count,1);const result=adapters[i].payload?.result;assert.ok(result);assert.equal(result.id,row.selection.id);assert.equal(result.attachmentId,row.selection.attachmentId);
   if(row.kind==='payload'){assert.equal(result.image?.mimeType,row.mimeType);assert.equal(result.image?.encodedCharacters,row.encodedCharacters);assert.equal(result.imageDisclosure,undefined);}
   else{assert.equal(result.image,undefined);if(row.kind==='repeat'){assert.equal(result.imageDisclosure?.status,'already_disclosed');assert.equal(result.imageDisclosure.mimeType,row.mimeType);assert.equal(result.imageDisclosure.mimeType+':'+result.imageDisclosure.sha256,row.payloadKey);sameSelection(selection(result.imageDisclosure.firstSelection),row.firstSelection!);if(row.firstImageView)assert.deepEqual(result.imageDisclosure.firstImageView,row.firstImageView);}else assert.equal(result.imageDisclosure,undefined);}
   if(row.imageView){const delivery=row.kind==='payload'?'prepared':row.kind==='repeat'?'already_disclosed':'metadata';for(const view of [reads[i].imageView,result.imageView]){assert.ok(view);assert.deepEqual(viewWithoutDelivery(view),viewWithoutDelivery(row.imageView));assert.equal(view.delivery,delivery);}}
   if(this.protocol==='bounded-views'){assert.deepEqual(result.imageBudget,row.imageBudget,'Adapter dropped the image quota');assert.deepEqual(result.hostBudget,row.hostBudget,'Adapter dropped the context quota');}
  }
  this.adapterVerified=true;return this.snapshot();
 }
 snapshot(){return {protocol:this.protocol,adapterPreparationVerified:this.adapterVerified,successfulReads:this.reads.length,imagePayloads:this.first.size,metadataReads:this.reads.filter(row=>row.kind==='metadata').length,repeatedDisclosureMetadata:this.reads.filter(row=>row.kind==='repeat').length,reads:this.reads.map(row=>({...row})),...(this.failed?{accountingFailure:this.failed}:{}),scope:'Observed host tool bytes; successful adapter preparation is asserted only when adapterPreparationVerified=true. Provider history resends and model attention are not measured'};}
}
