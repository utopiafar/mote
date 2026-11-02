/** Custom plugin page loader — Web fail-closed slice.
 *
 * Renders a trusted package entry inside an opaque-origin sandboxed
 * iframe. This slice ships NO interactive channel: without a verified
 * platform-owned navigation guard there is no pre-commit revocation
 * boundary on the open web, so the component must not create or deliver
 * a MessageChannel and must not invoke anything. The bridge engine
 * (custom-page-bridge.ts) remains the frozen contract for the later
 * desktop trusted-producer slice that supplies a real navigation guard. */
import React, {useRef} from 'react';
import {bridgeContractVersion} from './custom-page-bridge';

export interface CustomPageProps {
  /** Trusted resolved entry document (already parsed package content). Used
   * only when `entryUrl` is absent — it inherits the host script policy, so
   * script-bearing entries must load through an isolated entryUrl. */
  readonly entryHtml?: string;
  /** Isolated resolved entry URL (dedicated plugin origin/route), required
   * for script-bearing pages; opaque origin keeps bridge-only reach. */
  readonly entryUrl?: string;
  readonly title: string;
}

export function CustomPluginPage(props: CustomPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Deliberately no bridge: no caller watch/callback and no document
  // identity may substitute for a verified platform navigation guard.
  // A future guard-enabled host issues the channel only after the guard
  // claims the frame epoch; this component then has no decision to make.
  return <iframe ref={frameRef} className="plugin-custom-page" title={props.title}
    sandbox="allow-scripts" referrerPolicy="no-referrer"
    {...(props.entryUrl ? {src: props.entryUrl} : {srcDoc: props.entryHtml ?? ''})}/>;
}
export {CustomPageBridge, bridgeContractVersion} from './custom-page-bridge';
