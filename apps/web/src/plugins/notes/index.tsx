import {moteText} from '@mote/shared/i18n';
import type {PageEntry,PageProps} from '../../features/types';
import type {BuiltinWebPlugin} from '../types';
import {Notes} from './Notes';
import {createNotesController,type NotesController,type NotesControllerOptions} from './controller';

export {Notes} from './Notes';
export {QuickNoteDialog} from './QuickNoteDialog';
export {NoteOutbox,type NoteDraft,type NoteStorage,type QueuedNote} from './notes-state';
export {uploadNoteAttachment,uploadChatImage} from './note-attachments';
export {NotesController,createNotesController,type NotesControllerOptions,type NotesState} from './controller';

export const pages: PageEntry[] = [
  {
    id: 'notes',
    route: 'library/notes',
    label: moteText('随手记'),
    section: 'library',
    order: 5,
    featureId: 'mote.notes',
    render: ({api,onOpen:setEvidenceId,timelineRevision,refresh}: PageProps) => <Notes key={window.location.origin} api={api} namespace={window.location.origin} revision={timelineRevision} onOpen={setEvidenceId} onSaved={refresh} />,
  },
];

export const notes: BuiltinWebPlugin = {id: 'mote.notes', pages};

/** Plugin-owned lifecycle: activate creates the controller (draft, outbox,
 * attachment queue, list cache and subscriptions) and returns it to the
 * caller; dispose releases the same instance. */
export function createNotesPlugin(options: NotesControllerOptions) {
  let controller: NotesController | undefined;
  return {
    id: 'mote.notes' as const,
    get controller(): NotesController | undefined { return controller; },
    activate(): NotesController {
      controller ??= createNotesController(options);
      controller.start();
      return controller;
    },
    deactivate(): void {
      controller?.stop();
    },
    dispose(): void {
      controller?.dispose();
      controller = undefined;
    },
  };
}

export type NotesPlugin = ReturnType<typeof createNotesPlugin>;
