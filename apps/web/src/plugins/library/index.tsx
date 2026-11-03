import {moteText} from '@mote/shared/i18n';
import type {PageEntry,PageProps} from '../../features/types';
import type {BuiltinWebPlugin} from '../types';
import {Archive} from './Archive';
import {builtinCollections} from './collections';

export {Archive,ActivitySummary,RecordTimeline,Timeline,type ArchiveTab} from './Archive';
export {LibraryBrowseLayout,LibraryMaterials,LibraryMaterialRow} from './LibraryBrowse';
export {LibraryTimeline} from './LibraryTimeline';
export {CaptureSessions,SessionImage} from './CaptureSessions';
export {MediaSnapshot,MediaActivitySummary,MediaActivityContent} from './Media';
export {OriginalNoteRow,type OwnerBrowseEntry,type OwnerBrowsePage} from './owner-library-browse';
export {builtinCollections} from './collections';

/** The library package owns the owner's browse surfaces: the collection tab
 * registry, exact cursor/scope reads, and the list/detail return ticket. */
export const pages: PageEntry[] = [
  {
    id: 'archive',
    route: 'library',
    label: moteText('资料库'),
    section: 'library',
    order: 0,
    featureId: 'mote.library',
    render: ({api,devices,activity,onOpen,range,rangeSelectionKey,archiveTab,setArchiveTab,timelineRevision,refresh}: PageProps) =>
      <Archive onChanged={refresh} tab={archiveTab} setTab={setArchiveTab} api={api} devices={devices} range={range} rangeSelectionKey={rangeSelectionKey} activity={activity} revision={timelineRevision} onOpen={onOpen}/>,
  },
];

export const library: BuiltinWebPlugin = {id: 'mote.library', pages, collections: builtinCollections};
