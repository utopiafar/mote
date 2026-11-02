/** Custom plugin page loader: renders a trusted package entry inside a
 * sandboxed iframe and issues the RPC channel to the EXACT document that
 * loaded. A MessagePort — not the shared WindowProxy — carries every
 * envelope, so a document replacement under the same contentWindow can
 * neither send a request nor receive a response. */
import React, {useEffect, useRef} from 'react';
import {CustomPageBridge, bridgeContractVersion, type BridgeInvoker} from './custom-page-bridge';

export interface CustomPageProps {
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
   * the nonce on every approved navigation. */
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
    if (!frame?.contentWindow || navigatedRef.current) return;
    let loaded = false;
    let channel: MessageChannel | null = null;
    // Deterministic commit signal: pagehide fires on the document's own
    // window (reachable through the cross-origin WindowProxy) BEFORE a
    // replacement parses — revocation at commit, not at load.
    const endChannel = () => {
      if (navigatedRef.current) return;
      issuedDocument = null;
      issuedWindow = null;
      bridgeRef.current?.revoke();
      bridgeRef.current = null;
      channel?.port1.close(); channel?.port2.close(); channel = null;
      navigatedRef.current = true;
      props.onNavigated?.();
    };
    // The identity of the issued document: the frame's current window
    // proxy AND its Location object. Navigation replaces at least one of
    // them before the next load; unreadable is treated as changed.
    let issuedDocument: object | null = null;
    let issuedWindow: Window | null = null;
    const documentGone = (): boolean => {
      try { return !frame.contentWindow || frame.contentWindow !== issuedWindow || frame.contentWindow.location !== issuedDocument; }
      catch { return true; }
    };
    const onLoad = () => {
      if (!loaded) {
        loaded = true;
        issuedDocument = frame.contentWindow ? frame.contentWindow.location : null;
        issuedWindow = frame.contentWindow;
        if (!issuedDocument || !issuedWindow) { endChannel(); return; }
        // Issue the channel ONLY to the document that just loaded — a
        // later replacement never receives a port, so its requests have
        // no carrier and old responses die with the old document's port.
        channel = new MessageChannel();
        const bridge = new CustomPageBridge({
          instanceId: props.instanceId, nonce: props.nonce, documentKey: props.documentKey,
          generation: props.generation, visible: props.visible,
          documentAlive: () => !documentGone(),
          declared: props.declared, invoke: props.invoke,
          post: envelope => channel!.port1.postMessage(envelope),
          onRejected: props.onRejected,
        });
        channel.port1.onmessage = event => { void bridge.accept(event); };
        channel.port1.start();
        bridgeRef.current = bridge;
        frame.contentWindow?.postMessage(
          {contractVersion: bridgeContractVersion, nonce: props.nonce, documentKey: props.documentKey, kind: 'channel'}, '*', [channel.port2]);
        return;
      }
      // Any later load means the document was replaced (usually already
      // revoked by pagehide) — the mount stays disarmed until remount.
      endChannel();
    };
    frame.addEventListener('load', onLoad);
    return () => { frame.removeEventListener('load', onLoad); bridgeRef.current?.revoke(); bridgeRef.current = null; channel?.port1.close(); channel?.port2.close(); };
  }, [props.instanceId, props.nonce, props.documentKey]);

  useEffect(() => { if (props.visible()) bridgeRef.current?.show(); else bridgeRef.current?.hide(); }, [props.visible()]);

  // Opaque origin, script-only sandbox, no same-origin or top escape; the
  // report CSP is untouched — plugin pages use their own container.
  return <iframe ref={frameRef} className="plugin-custom-page" title={props.title}
    sandbox="allow-scripts" referrerPolicy="no-referrer"
    {...(props.entryUrl ? {src: props.entryUrl} : {srcDoc: props.entryHtml ?? ''})}/>;
}
export {CustomPageBridge, bridgeContractVersion};
