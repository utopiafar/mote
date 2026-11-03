import {useContext,useEffect,useMemo} from 'react';
import type {Api} from '../../api';
import {HomePluginContext} from './context';
import {createHomeController,type HomeController} from './controller';

/** A render-only consumer hook: a provided plugin owns the instance, while a
 * directly rendered page starts and stops one for that Api. */
export function useHomeController(api:Api,inputs:{captures?:number;deviceIds?:readonly string[]}={}):HomeController{
  const context=useContext(HomePluginContext);
  const standalone=useMemo(()=>context?.controller.api===api?undefined:createHomeController({api}),[context,api]);
  const deviceKey=(inputs.deviceIds??[]).map(id=>id).sort().join(',');
  useEffect(()=>{
    if(!standalone)return;
    standalone.start();
    return()=>standalone.stop();
  },[standalone]);
  const controller=context?.controller.api===api?context.controller:standalone!;
  useEffect(()=>{controller.setInputs({captures:inputs.captures,deviceIds:inputs.deviceIds});},[controller,inputs.captures,deviceKey]);
  return controller;
}
