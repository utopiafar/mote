/** Custom plugin page loader: renders a trusted package entry inside a
 * sandboxed iframe bound to a CustomPageBridge. The entry document comes
 * from the host's resolved package content — never an arbitrary URL — and
 * the frame keeps an opaque origin with no same-origin or top-navigation
 * escapes. */
import React, {useEffect, useRef} from 'react';
import {CustomPageBridge, bridgeContractVersion, type BridgeEnvelope, type BridgeInvoker} from './custom-page-bridge';

export interface CustomPageProps {
  /** Trusted resolved entry document (already parsed package content). */
  /** Trusted resolved entry document (already parsed package content). Used
   * only when `entryUrl` is absent — it inherits the host script policy, so
   * script-bearing entries must load through an isolated entryUrl. */
  readonly entryHtml?: string;
  /** Isolated resolved entry URL (dedicated plugin origin/route), required
   * for script-bearing pages; opaque origin keeps bridge-only reach. */
  readonly entryUrl?: string;
  readonly instanceId: string;
  readonly nonce: string;
  /** Per-document key issued for this exact loaded entry; rotate it with
   * the nonce on every navigation. */
  readonly documentKey: string;
  readonly generation: () => number;
  /** The real U02 visibility predicate (mounted/visible/suspended/disposed). */
  readonly visible: () => boolean;
  readonly declared: readonly string[];
  readonly invoke: BridgeInvoker;
  readonly title: string;
  readonly onNavigated?: () => void;
  readonly onRejected?: (reason: string) => void;
}

export function CustomPluginPage(props: CustomPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<CustomPageBridge | null>(null);
  const navigatedRef = useRef(false);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    let bridge: CustomPageBridge | null = null;
    let loaded = false;
    if (navigatedRef.current) return; // disarmed by a previous navigation — host must remount
    const onMessage = (event: MessageEvent) => { void bridge?.accept(event); };
    const onLoad = () => {
      if (navigatedRef.current) return;
      if (!loaded) {
        // The channel is issued only once the entry document actually
        // loaded — anything arriving earlier has no authority at all.
        loaded = true;
        bridge = new CustomPageBridge({
          instanceId: props.instanceId,
          nonce: props.nonce,
          documentKey: props.documentKey,
          frame: frame.contentWindow!,
          generation: props.generation,
          visible: props.visible,
          declared: props.declared,
          invoke: props.invoke,
          post: envelope => frame.contentWindow?.postMessage(envelope, '*'),
          onRejected: props.onRejected,
        });
        bridgeRef.current = bridge;
        // Issue the document-scoped channel to the just-loaded document —
        // only that document can answer with the documentKey.
        frame.contentWindow?.postMessage({contractVersion: bridgeContractVersion, nonce: props.nonce, documentKey: props.documentKey, kind: 'channel'}, '*');
        return;
      }
      // A later load means the document was replaced under the same
      // contentWindow: revoke the issued channel and let the host rotate
      // the document key before a replacement could use it.
      bridge?.revoke();
      bridge = null;
      bridgeRef.current = null;
      navigatedRef.current = true; // sticky: a replacement never re-arms this mount
      props.onNavigated?.();
    };
    frame.addEventListener('load', onLoad);
    window.addEventListener('message', onMessage);
    return () => { frame.removeEventListener('load', onLoad); window.removeEventListener('message', onMessage); bridge?.revoke(); bridgeRef.current = null; };
  }, [props.instanceId, props.nonce, props.documentKey]);

  useEffect(() => { if (props.visible()) bridgeRef.current?.show(); else bridgeRef.current?.hide(); }, [props.visible()]);

  // Opaque origin, script-only sandbox, no same-origin or top escape; the
  // report CSP is untouched — plugin pages use their own container.
  return <iframe ref={frameRef} className="plugin-custom-page" title={props.title}
    sandbox="allow-scripts" referrerPolicy="no-referrer"
    {...(props.entryUrl ? {src: props.entryUrl} : {srcDoc: props.entryHtml ?? ''})}/>;
}
export {CustomPageBridge, bridgeContractVersion};
