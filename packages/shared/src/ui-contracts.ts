/** Presentation contracts keep independent facts separate and preserve backend action authority. */
export type ProcessingJobView = {
  id:string;
  engine:'context-dag';
  title:string;
  state:string;
  lane:string;
  reason?:string;
  attempts:number;
  availableAt:number;
  dependencies:string[];
  outputs:string[];
  allowedActions:('retry-step'|'cancel')[];
};
export type ProcessingView = {
  jobs:ProcessingJobView[];
  limit:number;
  processors:{id:string;version:string;lane:string}[];
  queues:{lane:string;state:string;count:number}[];
};
