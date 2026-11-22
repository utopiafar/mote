import React from 'react';
import type {Api, Device, Status} from '../../api';
import {AnswerView} from '../../shell-components';
import type {AskController} from './controller';

const Conversations = React.lazy(() => import('./Conversations').then(module => ({default: module.Conversations})));

export function Ask({api, status, devices, onOpen, onSettings, controller}: {
  api: Api;
  status: Status;
  devices: Device[];
  onOpen: (ref: string) => void;
  onInsights: () => void;
  onSettings: () => void;
  controller?: AskController;
}) {
  return <Conversations api={api} configured={status.agent.configured} devices={devices} onOpen={onOpen}
    onSettings={onSettings} controller={controller}
    renderAnswer={(answer, openReference) => <AnswerView answer={answer} onOpen={openReference} compact/>}/>;
}
