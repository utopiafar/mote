import {builtinCollections} from '../../features/collections';
import type {BuiltinWebPlugin} from '../types';

/**
 * The Memory workspace package owns the list/detail/filter reads, the manual
 * extraction and integration work pages, deletion confirmation, version
 * history and owner-question conversations. Mounted surfaces share the
 * owner-scoped resource cache; this package exposes the same components to
 * the shell, feature panels and Search detail.
 */
export const memory:BuiltinWebPlugin={
  id:'mote.memory',
  collections:builtinCollections.filter(entry=>entry.featureId==='mote.memory'),
};

export {Memories,MemoryDetailPage,memoryStatus} from './Memories';
export type {Memory} from './Memories';
export {MemoryTopics} from './MemoryTopics';
export type {ContextTree} from './MemoryTopics';
export {MemoryHistory,readMemoryHistory,savedMemoryValidAt} from './MemoryHistory';
export {MemoryProgress,memoryJobLabel,useMemoryJob} from './MemoryProgress';
export type {MemoryInputSummary,MemoryJob,MemoryRecipeProgress} from './MemoryProgress';
export {MemoryDeleteDialog} from './MemoryDeleteDialog';
export {ManualMemoryWorkspace,installMemoryWorkspaceStyles} from './ManualMemoryWorkspace';
export type {MemoryWorkLaunch} from './ManualMemoryWorkspace';
export {ManualMemoryRecipes} from './ManualMemoryRecipes';
export {MemoryRecipeSelection} from './MemoryRecipeSelection';
export {MemoryWorkChoices} from './MemoryWorkChoices';
export type {ExtractionChoice} from './MemoryWorkChoices';
export {OwnerQuestionConversation,OwnerQuestionLinks,OwnerQuestionWorkspace} from './OwnerQuestions';
