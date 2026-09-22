/** Cooperative transport admission; yielding is not a network or record failure. */
export class UploadSliceYield extends Error {}
export function requestBytes(body:unknown){return body instanceof Uint8Array?body.byteLength:Buffer.byteLength(JSON.stringify(body)??'');}
export class UploadSlice {
  bytes=0;requests=0;
  private started:number;
  constructor(private maxBytes=4*1024*1024,private maxRequests=64,private maxMs=15000,private now=Date.now){this.started=now();}
  admit(body:unknown){
    // Finish an already admitted request. Overshoot is bounded by one request
    // (original file parts are 4 MiB); metadata must not prevent any part fitting.
    if(this.requests&&(this.bytes>=this.maxBytes||this.requests>=this.maxRequests||this.now()-this.started>=this.maxMs))throw new UploadSliceYield();
    this.bytes+=requestBytes(body);this.requests++;
  }
}
