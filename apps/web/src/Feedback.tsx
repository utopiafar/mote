import { ExternalLink, MessageSquare } from 'lucide-react';
import { githubFeedbackUrl } from '@mote/shared/feedback';
import { version } from '../package.json';

export function Feedback({profile, runtime}: {profile?: string; runtime?: string}) {
  // Only generic deployment labels may leave the private node in the issue URL.
  const environment = [
    ['dev', 'test', 'prod', 'legacy'].includes(profile ?? '') ? profile : undefined,
    ['native', 'docker'].includes(runtime ?? '') ? runtime : undefined,
  ].filter(Boolean).join(' · ');
  const href = githubFeedbackUrl({version, platform: 'Web', environment: environment || undefined});
  return <a className="preference-menu-row feedback-link" href={href} target="_blank" rel="noreferrer">
    <span className="preference-menu-icon neutral"><MessageSquare size={21}/></span>
    <span><strong>反馈</strong><small>前往 GitHub，可附图片或诊断包</small></span>
    <ExternalLink size={17}/>
  </a>;
}
