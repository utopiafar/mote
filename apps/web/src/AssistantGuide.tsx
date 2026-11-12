import {moteText} from '@mote/shared/i18n';
import {DiscoveryLink} from './DiscoveryLink';
import {assistantDiscoveryTarget,assistantEntrypoints} from './assistant-entrypoints';

/** The assistant directory reserves the destinations for this cycle. A page
 * that is not registered yet, or whose server capability is not active,
 * remains a non-executable row; it never falls through to another page. */
export function AssistantGuide(){
  if(!assistantEntrypoints.length)return null;
  return <details className="assistant-guide" data-assistant-guide>
    <summary>{moteText('助理功能')}</summary>
    <p className="assistant-guide-note">{moteText('助理接入的页面；未接入前不会执行任何工作。')}</p>
    <div className="guide-unit-list">{assistantEntrypoints.map(entry=><div className="guide-unit" data-assistant-entry={entry.pageId} key={entry.pageId}>
      <DiscoveryLink target={assistantDiscoveryTarget(entry)} className="guide-unit-link">
        <span><strong>{moteText(entry.title)}</strong><small className="assistant-guide-purpose">{moteText(entry.purpose)}</small></span>
        <span className="guide-chevron" aria-hidden="true">›</span>
      </DiscoveryLink>
    </div>)}</div>
  </details>;
}
