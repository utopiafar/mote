import {moteText} from '@mote/shared/i18n';
import {useEffect,useMemo} from 'react';
import type {Api} from '../../api';
import {modelSetupHref} from '../../ModelStartGuide';
import type {PageEntry,PageProps} from '../../features/types';
import type {BuiltinWebPlugin} from '../types';
import {Ask} from './Ask';
import {AskController,createAskController} from './controller';

export {Ask} from './Ask';
export {ConversationHeading,ConversationComposer} from './ConversationShell';
export {conversationFailure,ConversationDialog,ConversationTurnDetails} from './ConversationTurnDetails';
export {SaveConversationRecord} from './SaveConversationRecord';
export {AnswerMarkdown,answerPreview,citationLinks} from './AnswerMarkdown';
export {QueryProgress,progressLabel,type QueryRun} from './QueryProgress';
export {queryRecovery,type AdoptedQuery,type OwnedQuery,type PendingQuery} from './query-recovery';
export {readOriginTurn,conversationTurnRoute,type OriginTurn} from './conversation-origin';
export {associateChatScope,clearChatReloadDraft,preserveChatForLanguageReload,unsentDrafts,unsentImages,type ChatAttachment,type ChatImageUpload} from './chat-drafts';
export {AskController,createAskController,useAskController,type AskControllerOptions,type AskRunHandlers} from './controller';

export interface AskPluginOptions {
  readonly api: Api;
  readonly controller?: AskController;
}

/** Plugin-owned lifecycle: activation starts the run poller and view scope;
 * deactivation stops reads while retaining the owner's drafts and recovery
 * identity. Disposal releases the controller's lifetime. */
export function createAskPlugin(options: AskPluginOptions) {
  const controller=options.controller??createAskController({api:options.api});
  let active=false;
  return {
    id:'mote.ask' as const,
    get controller(): AskController {return controller;},
    activate(): AskController {
      if(!active){active=true;controller.start();}
      return controller;
    },
    deactivate(): void {
      if(!active)return;
      active=false;
      controller.stop();
    },
    dispose(): void {
      active=false;
      controller.dispose();
    },
  };
}

export type AskPlugin=ReturnType<typeof createAskPlugin>;

const plugins=new WeakMap<Api,AskPlugin>();
/** One plugin instance per owner connection; navigating away only deactivates
 * it, so an in-flight run and its drafts resume under the same owner. */
export function askPlugin(api:Api){let plugin=plugins.get(api);if(!plugin){plugin=createAskPlugin({api});plugins.set(api,plugin);}return plugin;}

/** Page boundary: activate the plugin-owned controller and pass it to Ask.
 * The route component itself only renders; reads/polling live in the
 * controller and stop while the document is hidden. */
export function AskPage(props:PageProps){
  const plugin=useMemo(()=>askPlugin(props.api),[props.api]);
  useEffect(()=>{plugin.activate();return()=>plugin.deactivate();},[plugin]);
  return props.status?<Ask api={props.api} devices={props.devices} status={props.status} controller={plugin.controller} onOpen={props.onOpen} onInsights={()=>props.onPage('insights')} onSettings={()=>{window.location.hash=modelSetupHref('providers',window.location.hash);}}/>:null;
}

export const pages: PageEntry[] = [
  {
    id: 'ask',
    route: 'ask',
    label: moteText('问一问'),
    featureId: 'mote.ask',
    render: (props: PageProps) => <AskPage {...props}/>,
  },
];

/** The Ask package owns query runs, conversation history, citations, turn
 * saving and the per-owner drafts/recovery state those surfaces read. */
export const ask: BuiltinWebPlugin = {id: 'mote.ask', pages};
