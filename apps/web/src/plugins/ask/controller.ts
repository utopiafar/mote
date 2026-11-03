import {useEffect,useMemo} from 'react';
import {ViewLifetime} from '@mote/shared/plugin-view-lifetime';
import type {Api} from '../../api';
import {readResource} from '../../resource-cache';
import type {QueryRun} from './QueryProgress';

export interface AskRunHandlers {
  readonly onRun:(run:QueryRun)=>void;
  readonly onError:(error:unknown)=>void;
}

export interface AskControllerOptions {
  readonly api:Api;
  readonly document?:Document;
  /** Tests inject a shorter cadence; the product reads once per second while a
   * run is active. */
  readonly intervalMs?:number;
  readonly retryMs?:number;
}

/** Owns the in-flight query run poller. Polling is gated by the U02 view
 * lifetime: hiding the page aborts the current read and clears the timer, and
 * returning issues one fresh read before the normal cadence resumes. Every
 * request carries the controller's abort signal, so a late response after an
 * owner/view change can never publish. */
export class AskController {
  readonly api:Api;
  readonly lifetime=new ViewLifetime();
  readonly #document?:Document;
  readonly #intervalMs:number;
  readonly #retryMs:number;
  #runId?:string;
  #handlers?:AskRunHandlers;
  #timer?:ReturnType<typeof setTimeout>;
  #request?:AbortController;
  #started=false;
  #visible=true;

  constructor(options:AskControllerOptions){
    this.api=options.api;
    this.#document=options.document??(typeof document==='undefined'?undefined:document);
    this.#intervalMs=options.intervalMs??1000;
    this.#retryMs=options.retryMs??3000;
  }

  get runId():string|undefined{return this.#runId;}
  get polling():boolean{return this.#timer!==undefined||this.#request!==undefined;}

  start():void{
    if(this.#started)return;
    this.#started=true;
    this.#visible=!this.#hidden();
    this.lifetime.show();
    if(!this.#visible)this.lifetime.suspend();
    this.#document?.addEventListener('visibilitychange',this.#visibility);
    // A child poll effect can run before the page boundary activates the
    // plugin. Resume that registered run once activation makes the view live.
    if(this.#runId)this.#restart();
  }

  stop():void{
    if(!this.#started)return;
    this.#started=false;
    this.#document?.removeEventListener('visibilitychange',this.#visibility);
    this.stopPolling();
    if(this.lifetime.state!=='disposed')this.lifetime.suspend();
  }

  dispose():void{
    this.stop();
    this.lifetime.dispose();
  }

  /** Follow one exact run id. A new id/registration aborts the previous read
   * immediately; terminal replies end the loop without another read. */
  poll(runId:string,handlers:AskRunHandlers):void{
    this.#runId=runId;
    this.#handlers=handlers;
    this.#restart();
  }

  /** Explicit "check result" for the same run identity, without creating a
   * second run or replaying its admission request. */
  recheck():void{this.#restart();}

  stopPolling():void{
    if(this.#timer!==undefined){clearTimeout(this.#timer);this.#timer=undefined;}
    this.#request?.abort();this.#request=undefined;
  }

  /** Browsers expose the reliable paused-tab state as visibilityState; JSDOM
   * reports `hidden` while prerendering, so the boolean fallback stays for
   * documents without a visibilityState. */
  #hidden():boolean{const state=this.#document?.visibilityState;return state?state==='hidden':Boolean(this.#document?.hidden);}

  #visibility=():void=>{
    if(!this.#started)return;
    if(this.#hidden()){this.#visible=false;this.stopPolling();this.lifetime.suspend();return;}
    this.#visible=true;this.lifetime.show();this.#restart();
  };

  #restart():void{
    this.stopPolling();
    if(!this.#started||!this.#visible||!this.#runId)return;
    void this.#read();
  }

  async #read():Promise<void>{
    const runId=this.#runId,handlers=this.#handlers;
    if(!this.#started||!this.#visible||!runId||!handlers)return;
    const request=new AbortController();
    this.#request=request;
    try{
      const current=await readResource<QueryRun>(this.api,`/api/query-runs/${runId}`,request.signal);
      if(request.signal.aborted||this.#runId!==runId)return;
      handlers.onRun(current);
      if(current.status==='running')this.#schedule(this.#intervalMs);
    }catch(error){
      if(request.signal.aborted||this.#runId!==runId)return;
      handlers.onError(error);
      this.#schedule(this.#retryMs);
    }finally{
      if(this.#request===request)this.#request=undefined;
    }
  }

  #schedule(delay:number):void{
    if(!this.#started||!this.#visible||!this.#runId)return;
    if(this.#timer!==undefined)clearTimeout(this.#timer);
    this.#timer=setTimeout(()=>{this.#timer=undefined;void this.#read();},delay);
  }
}

export function createAskController(options:AskControllerOptions):AskController{return new AskController(options);}

/** The page boundary may provide the plugin-owned controller. Direct component
 * renders (tests and embedded surfaces) create the same controller locally. */
export function useAskController(api:Api,provided?:AskController):AskController{
  const local=useMemo(()=>createAskController({api}),[api]);
  const controller=provided?.api===api?provided:local;
  useEffect(()=>{
    if(provided?.api===api)return;
    controller.start();
    return()=>controller.stop();
  },[controller,provided,api]);
  return controller;
}
