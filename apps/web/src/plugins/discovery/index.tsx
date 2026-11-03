import { moteText } from '@mote/shared/i18n';
import React from 'react';
import { modelSetupHref } from '../../ModelStartGuide';
import type { PageEntry, PageProps } from '../../features/types';
import type { BuiltinWebPlugin } from '../types';

const Insights = React.lazy(() => import('./Insights').then(module => ({ default: module.Insights })));

/** The discovery package owns report history, exact report reading, the
 * sandboxed report frame and the automatic-generation policy editor. */
export const pages: PageEntry[] = [
  {
    id: 'insights',
    route: 'library/insights',
    label: moteText('发现'),
    section: 'library',
    order: 7,
    featureId: 'mote.insights',
    render: ({ api, status, onOpen: setEvidenceId, range, timelineRevision, refresh }: PageProps) => <Insights api={api} refreshVersion={timelineRevision} range={range} configured={status?.agent.configured ?? false} onOpen={setEvidenceId} onSettings={() => { window.location.hash = modelSetupHref('providers', window.location.hash); }} onChanged={refresh} />,
  },
];

export const discovery: BuiltinWebPlugin = { id: 'mote.insights', pages };

export { Insights } from './Insights';
export { InsightReport } from './InsightReport';
export { InsightReportFrame } from './InsightReportFrame';
export { InsightProgress, type InsightRun } from './InsightProgress';
export { InsightAutomaticSettings } from './InsightAutomaticSettings';
export { useInsightHistory } from './useInsightHistory';
export { reportDocument } from './report-document';
export {
  REPORT_SIZE_MESSAGE,
  REPORT_SOURCE_MESSAGE,
  REPORT_MAX_HEIGHT,
  acceptedReportHeight,
  acceptedReportSource,
  newReportSizeToken,
  reportSizeScript,
} from './report-sizing';
