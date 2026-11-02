/** Custom plugin page loader: renders a trusted package entry inside a
 * sandboxed iframe bound to a CustomPageBridge. The entry document comes
 * from the host's resolved package content — never an arbitrary URL — and
 * the frame keeps an opaque origin with no same-origin or top-navigation
 * escapes. */
import React, {useEffect, useRef} from 'react';
import {CustomPageBridge, bridgeContractVersion, type BridgeInvoker} from './custom-page-bridge';

export interface CustomPageProps {
  /** Trusted resolved entry document (already parsed package content). */
  readonly entryHtml: string;
  readonly instanceId: string;
  readonly nonce: string;
  readonly generation: () => number;
  readonly declared: readonly string[];
  readonly invoke: BridgeInvoker;
  readonly title: string;
  readonly onHide?: () => void;
  readonly onRevoke?: () => void;
}

export function CustomPluginPage(props: CustomPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<CustomPageBridge | null>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    const bridge = new CustomPageBridge({
      instanceId: props.instanceId,
      nonce: props.nonce,
      frame: frame.contentWindow,
      generation: props.generation,
      declared: props.declared,
      invoke: props.invoke,
      post: envelope => frame.contentWindow?.postMessage(envelope, '*'),
    });
    bridgeRef.current = bridge;
    const onMessage = (event: MessageEvent) => { void bridge.accept(event); };
    window.addEventListener('message', onMessage);
    return () => { window.removeEventListener('message', onMessage); bridge.revoke(); bridgeRef.current = null; };
  }, [props.instanceId, props.nonce]);

  useEffect(() => { if (props.generation() === 0) bridgeRef.current?.hide(); }, [props.generation()]);

  // Opaque origin, script-only sandbox, no same-origin or top escape; the
  // report CSP is untouched — plugin pages use their own container.
  return <iframe ref={frameRef} className="plugin-custom-page" title={props.title}
    sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={props.entryHtml}/>;
}
export {CustomPageBridge, bridgeContractVersion};
