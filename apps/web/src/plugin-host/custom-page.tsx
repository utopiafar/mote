/** Custom plugin page loader.
 *
 * Every entry runs in an opaque-origin sandbox. Browser pages receive one
 * MessagePort only after their first entry load; the port carries the same
 * nonce-bound RPC envelope as Desktop and dies on navigation or unmount.
 * No host API object or connection credential is exposed to the frame.
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
  /** Main-owned revocation notification — required for guarded
   * activation: a cancelled navigation revokes the epoch without
   * producing another load, and the bridge must die with it. */
  onCustomPageRevoked?: (listener: (event: {instanceId: string; nonce: string; documentKey: string; frameTreeNodeId: number; epoch: number}) => void) => () => void;
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
  /** Reports the one live channel to the host mount owner: the bridge on
   * issuance and null when navigation, revocation or unmount closes it. */
  readonly onBridgeChange?: (bridge: CustomPageBridge | null) => void;
  readonly onNavigated?: () => void;
  readonly onRejected?: (reason: string) => void;
}

export function CustomPluginPage(props: CustomPageProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<CustomPageBridge | null>(null);
  const navigatedRef = useRef(false);
  const mote = (window as unknown as {mote?: CustomPageMoteApi}).mote;
  const bridged = Boolean(props.entryUrl && props.instanceId && props.nonce && props.documentKey && props.declared?.length && props.invoke && props.visible);
  const guarded = Boolean(mote?.customPagePrepare && mote?.customPageClaim && mote?.onCustomPageRevoked && bridged);
  const browser = bridged && !guarded;

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
    // Subscribe to the main-owned revocation BEFORE the claim: a
    // cancelled navigation revokes the epoch with no further load, so
    // the issued bridge must be fenced by this signal, not by loads.
    let grantedEpoch = 0;
    const offRevoked = mote!.onCustomPageRevoked!(event => {
      // One binding per mount: a pending (unclaimed) revocation also
      // matches — its late claim must never rebuild the channel.
      if (event.instanceId === props.instanceId && event.nonce === props.nonce && event.documentKey === props.documentKey && (grantedEpoch === 0 || event.epoch === grantedEpoch))
        endChannel();
    });
    const endChannel = () => {
      if (navigatedRef.current) return;
      alive = false;
      bridgeRef.current?.revoke();
      bridgeRef.current = null;
      props.onBridgeChange?.(null);
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
      grantedEpoch = grant.epoch;
      // The port is delivered ONLY if this is still the latest load and
      // the effect is still live — a replaced document can never get it.
      if (loadSeq !== claimingSeq || navigatedRef.current || !alive || frameRef.current !== frame) return;
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
      props.onBridgeChange?.(bridge);
      // The handshake carries the bound identity AND granted epoch —
      // the page constructs every request solely from what it receives.
      frame.contentWindow?.postMessage(
        {contractVersion: bridgeContractVersion, nonce: props.nonce, documentKey: props.documentKey, instanceId: props.instanceId, generation: grant.epoch, kind: 'channel'}, '*', [channel.port2]);
    };
    frame.addEventListener('load', onLoad);
    // Prepare the nonce-bound frame before it navigates anywhere; a
    // refused prepare degrades to the trusted entry render-only.
    void mote!.customPagePrepare!({instanceId: props.instanceId!, nonce: props.nonce!, documentKey: props.documentKey!, entryUrl: props.entryUrl!})
      .then(() => {
        // Fence the continuation: only the live effect that started this
        // prepare may navigate the still-mounted frame.
        if (!alive || frameRef.current !== frame || navigatedRef.current) return;
        const bound = new URL(props.entryUrl!, window.location.href);
        bound.searchParams.set('moteFrame', props.nonce!);
        entryStarted = true;
        frame.src = bound.toString();
      })
      .catch(() => { if (alive && frameRef.current === frame && !navigatedRef.current) frame.src = props.entryUrl!; });
    return () => {
      alive = false; offRevoked(); frame.removeEventListener('load', onLoad);
      bridgeRef.current?.revoke(); bridgeRef.current = null; props.onBridgeChange?.(null);
      channel?.port1.close(); channel?.port2.close();
    };
  }, [props.instanceId, props.nonce, props.documentKey, props.entryUrl]);

  useEffect(() => {
    if (!browser) return;
    const frame = frameRef.current;
    if (!frame || navigatedRef.current) return;
    let channel: MessageChannel | null = null;
    let alive = true;
    let loads = 0;
    const closeChannel = () => {
      alive = false;
      bridgeRef.current?.revoke();
      bridgeRef.current = null;
      props.onBridgeChange?.(null);
      channel?.port1.close(); channel?.port2.close(); channel = null;
    };
    const onLoad = () => {
      if (!alive || navigatedRef.current || frameRef.current !== frame) return;
      loads++;
      if (loads > 1) {
        closeChannel();
        navigatedRef.current = true;
        props.onNavigated?.();
        return;
      }
      const source = frame.contentWindow;
      if (!source) return;
      // WindowProxy survives navigation, but its Location object does not.
      // Retaining this exact object fences a transferred old port as soon as
      // the replacement document commits, even before its load event.
      const documentLocation = source.location;
      const issued = new MessageChannel();
      channel = issued;
      const bridge = new CustomPageBridge({
        instanceId: props.instanceId!, nonce: props.nonce!, documentKey: props.documentKey!,
        generation: () => 1, visible: props.visible!,
        documentAlive: () => alive && frame.contentWindow === source && source.location === documentLocation,
        declared: props.declared!, invoke: props.invoke!,
        post: envelope => issued.port1.postMessage(envelope),
        onRejected: props.onRejected,
      });
      issued.port1.onmessage = event => { if (channel === issued) void bridge.accept(event); };
      issued.port1.start();
      bridgeRef.current = bridge;
      props.onBridgeChange?.(bridge);
      source.postMessage(
        {contractVersion: bridgeContractVersion, nonce: props.nonce, documentKey: props.documentKey, instanceId: props.instanceId, generation: 1, kind: 'channel'}, '*', [issued.port2]);
    };
    frame.addEventListener('load', onLoad);
    frame.src = props.entryUrl!;
    return () => {
      frame.removeEventListener('load', onLoad);
      closeChannel();
    };
  }, [props.instanceId, props.nonce, props.documentKey, props.entryUrl]);

  useEffect(() => { if (props.visible && bridgeRef.current) props.visible() ? bridgeRef.current.show() : bridgeRef.current.hide(); }, [props.visible && props.visible()]);

  // Opaque origin, script-only sandbox, no same-origin or top escape. RPC
  // modes bind src from their load-owning effect; render-only entries load
  // directly and never receive a port.
  return <iframe ref={frameRef} className="plugin-custom-page" title={props.title}
    sandbox="allow-scripts" referrerPolicy="no-referrer"
    {...(guarded || browser ? {} : props.entryUrl ? {src: props.entryUrl} : {srcDoc: props.entryHtml ?? ''})}/>;
}
export {CustomPageBridge, bridgeContractVersion};
