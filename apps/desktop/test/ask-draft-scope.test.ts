import {expect,it} from 'vitest';
import {AskDraftScopes} from '../src/ask-draft-scope';
import {defaultConfig} from '../src/config';
import type {Status} from '../src/contracts';

const status = (serverUrl: string, deviceId: string): Status => ({
  config: {...defaultConfig(), serverUrl, deviceId},
}) as Status;

it('keeps each window draft with its exact owner session and never exposes it to another', () => {
  const scopes = new AskDraftScopes<{question: string; running: string}>();
  const first = status('https://first.invalid', 'generated-device-one');
  const second = status('https://second.invalid', 'generated-device-one');
  const otherDevice = status('https://first.invalid', 'generated-device-two');
  const firstDraft = {question: 'Generated first unsent question', running: 'generated-first-run'};
  const secondDraft = {question: 'Generated second unsent question', running: 'generated-second-run'};

  expect(scopes.switch(first, first, firstDraft)).toBe(firstDraft);
  expect(scopes.switch(first, second, firstDraft)).toBeUndefined();
  expect(scopes.switch(second, first, secondDraft)).toEqual(firstDraft);
  expect(scopes.switch(first, second, firstDraft)).toEqual(secondDraft);
  expect(scopes.switch(second, otherDevice, secondDraft)).toBeUndefined();
  expect(scopes.switch(otherDevice, first, undefined)).toEqual(firstDraft);
  expect(scopes.switch(first, second, firstDraft)).toEqual(secondDraft);
});

it('only lets a draft made before the first connection follow that initial owner session', () => {
  const scopes = new AskDraftScopes<string>();
  const unconnected = status('', 'generated-device');
  const connected = status('https://generated.invalid', 'generated-device');
  expect(scopes.switch(unconnected, connected, 'Generated pre-connection draft')).toBe('Generated pre-connection draft');
});
