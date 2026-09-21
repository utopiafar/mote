/** Only host-authored errors cross the model boundary. Provider exceptions stay private. */
export class ContextToolError extends Error {
  constructor(readonly code:string,message:string,readonly recovery:'correct_arguments'|'use_existing_evidence'|'stop',readonly details:Record<string,unknown>={}){super(message);this.name='ContextToolError';}
  toJSON(){return {code:this.code,message:this.message,recovery:this.recovery,details:this.details};}
}
