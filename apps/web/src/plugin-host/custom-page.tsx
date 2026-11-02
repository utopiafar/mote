/** Custom plugin page loader.
 *
 * Web fail-closed default: renders a trusted package entry inside an
 * opaque-origin sandboxed iframe and issues NO channel — the open web
 * has no pre-commit revocation boundary for opaque frames.
 *
 * Desktop trusted-guard path (frozen contract with the Electron main
 * process): when the host supplies `window.mote.customPagePrepare` and
 * `customPageClaim`, the frame is prepared with a host nonce before it
 * loads, claims its exact frame epoch on load, and only then receives a
 * MessagePort-bound channel. Later navigation is cancelled and the
 * epoch revoked in main — approved navigation means remounting with a
 * fresh prepare/nonce/documentKey/claim. No caller-supplied guard or
 * callback substitutes for that authority. */
import React, {useEffect, useRef} from 'react';
import {CustomPageBridge, bridgeContractVersion, type BridgeInvoker} from './custom-page-bridge';

interface CustomPageMoteApi {
  customPagePrepare?: (target: {instanceId: string; nonce: string; documentKey: string; entryUrl: string}) => Promise<{epoch: number}>;
  customPageClaim?: (claim: {instanceId: string; nonce: string; documentKey: string}) => Promise<{frameTreeNodeId: number; epoch: number}>;
}

export interface CustomPageProps {
  /** Trusted resolved entry document (already parsed package content). Used
   * only when `entryUrl` is absent — it inherits the host script policy, so
   * script-bearing entries must load through an isolated entryUrl. */
  readonly entryHtml?: string;
  /** Isolated resolved entry URL (dedicated plugin origin/route), required
   * for script-bearing pages; opaque origin keeps bridge-only reach. */
  readonly entryUrl?: string;
  readonly title: string;
  /** Trusted-guard identity — only consumed when the platform API exists. */
  readonly instanceId?: string;
  readonly nonce?: string;
  readonly documentKey?: string;
  readonly visible?: () => boolean;
  readonly declared?: readonly string[];
  readonly invoke?: BridgeInvoker;
  readonly onNavigated?: () => void;
  readonly onRejected?: (reason: string) => void;
}

export function CustomPluginPage(props: CustomPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<CustomPageBridge | null>(null);
  const navigatedRef = useRef(false);
  const mote = (window as unknown as {mote?: CustomPageMoteApi}).mote;
  const guarded = Boolean(mote?.customPagePrepare && mote?.customPageClaim && props.entryUrl && props.instanceId && props.nonce && props.documentKey && props.declared?.length && props.invoke && props.visible);

  useEffect(() => {
    if (!guarded) return;
    const frame = frameRef.current;
    if (!frame || navigatedRef.current) return;
    // Load sequence: only the load of the PREPARED entry navigation may
    // claim — the initial about:blank load and any earlier navigation are
    // ignored, and a resolved claim is delivered only while that exact
    // load is still the latest (a later load seq ends the channel).
    let entryStarted = false;
    let loadSeq = 0;
    let channel: MessageChannel | null = null;
    let alive = true;
    const endChannel = () => {
      if (navigatedRef.current) return;
      alive = false;
      bridgeRef.current?.revoke();
      bridgeRef.current = null;
      channel?.port1.close(); channel?.port2.close(); channel = null;
      navigatedRef.current = true;
      props.onNavigated?.();
    };
    const onLoad = async () => {
      if (!entryStarted) return; // about:blank or an earlier navigation
      loadSeq++;
      if (loadSeq > 1) { endChannel(); return; }
      const claimingSeq = loadSeq;
      // Claim the exact frame epoch — a rejected claim never issues.
      let grant: {frameTreeNodeId: number; epoch: number};
      try { grant = await mote!.customPageClaim!({instanceId: props.instanceId!, nonce: props.nonce!, documentKey: props.documentKey!}); }
      catch { return; }
      // The port is delivered ONLY if this is still the latest load —
      // a document that started replacing itself can never receive it.
      if (loadSeq !== claimingSeq || navigatedRef.current) return;
      channel = new MessageChannel();
      const bridge = new CustomPageBridge({
        instanceId: props.instanceId!, nonce: props.nonce!, documentKey: props.documentKey!,
        generation: () => grant.epoch, visible: props.visible!, documentAlive: () => alive,
        declared: props.declared!, invoke: props.invoke!,
        post: envelope => channel!.port1.postMessage(envelope),
        onRejected: props.onRejected,
      });
      channel.port1.onmessage = event => { void bridge.accept(event); };
      channel.port1.start();
      bridgeRef.current = bridge;
      frame.contentWindow?.postMessage(
        {contractVersion: bridgeContractVersion, nonce: props.nonce, documentKey: props.documentKey, kind: 'channel'}, '*', [channel.port2]);
    };
    frame.addEventListener('load', onLoad);
    // Prepare the nonce-bound frame before it navigates anywhere; a
    // refused prepare degrades to the trusted entry render-only.
    void mote!.customPagePrepare!({instanceId: props.instanceId!, nonce: props.nonce!, documentKey: props.documentKey!, entryUrl: props.entryUrl!})
      .then(() => {
        const frame = frameRef.current;
        if (!frame || navigatedRef.current) return;
        const bound = new URL(props.entryUrl!, window.location.href);
        bound.searchParams.set('moteFrame', props.nonce!);
        entryStarted = true;
        frame.src = bound.toString();
      })
      .catch(() => { if (frameRef.current && !navigatedRef.current) frameRef.current.src = props.entryUrl!; });
    return () => { alive = false; frame.removeEventListener('load', onLoad); bridgeRef.current?.revoke(); bridgeRef.current = null; channel?.port1.close(); channel?.port2.close(); };
  }, [props.instanceId, props.nonce, props.documentKey, props.entryUrl]);

  useEffect(() => { if (props.visible && bridgeRef.current) props.visible() ? bridgeRef.current.show() : bridgeRef.current.hide(); }, [props.visible && props.visible()]);

  // Opaque origin, script-only sandbox, no same-origin or top escape.
  // Guarded mode binds the src only after prepare resolves; unguarded
  // mode renders the entry directly with zero RPC (the #453 default).
  return <iframe ref={frameRef} className="plugin-custom-page" title={props.title}
    sandbox="allow-scripts" referrerPolicy="no-referrer"
    {...(guarded ? {} : props.entryUrl ? {src: props.entryUrl} : {srcDoc: props.entryHtml ?? ''})}/>;
}
export {CustomPageBridge, bridgeContractVersion};
