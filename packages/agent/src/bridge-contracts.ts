/** Private adapter framing only. Tool grants and disclosure live in the session. */
export interface BridgeToolRequest {
  tool:string;
  readArguments():Promise<Record<string,unknown>>;
}

/** Delivery completion and disconnection remain visible to the disclosure owner. */
export interface BridgeToolReply {
  readonly destroyed:boolean;
  writeHead(status:number):BridgeToolReply;
  end(body:string,delivered?:()=>void):void;
  once(event:'close',listener:()=>void):unknown;
  off(event:'close',listener:()=>void):unknown;
}

export type BridgeToolHandler=(request:BridgeToolRequest,reply:BridgeToolReply)=>Promise<void>;

/** One staged read. `value` is the exact body the existing tool would return;
 * the Host-owned sender/attempt decides whether `confirm` is ever called. */
export interface PreparedToolDelivery {
  readonly value: unknown;
  /** One-shot: revalidate authority/signal, then publish the staged ledger. */
  confirm(): void;
  /** One-shot: drop the staged ledger and deferred callbacks. */
  discard(): void;
}

export type PrepareToolDelivery=(tool:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<PreparedToolDelivery>;
