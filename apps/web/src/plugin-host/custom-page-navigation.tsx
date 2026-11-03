/** Navigation mounting for manifest-declared custom pages.
 *
 * A package manifest declares a custom page as a `page` contribution that
 * carries a host-runtime `entry` document. The host resolves that entry to a
 * trusted isolated URL and registers a normal navigable page whose renderer is
 * the host-owned CustomPluginPage — external documents never become trusted
 * React components. The page's one live bridge is owned here so navigation
 * unmount, plugin uninstall and host revocation all close it. */
import React, {useCallback, useMemo} from 'react';
import type {ViewLifetime} from '@mote/shared/plugin-view-lifetime';
import type {WebContribution} from '../features/host';
import {CustomPluginPage} from './custom-page';
import type {BridgeInvoker, CustomPageBridge} from './custom-page-bridge';

export interface CustomPageManifestContribution {
  readonly id: string;
  readonly surface: string;
  readonly runtime: string;
  readonly entry?: string;
}

/** The manifest subset required for navigation projection. The package
 * Manifest stays the only authored authority; this type never carries code,
 * callbacks or URLs. */
export interface CustomPageManifest {
  readonly id: string;
  readonly name?: string;
  readonly contributions?: readonly CustomPageManifestContribution[];
}

export interface CustomPageDeclaration {
  readonly id: string;
  readonly title: string;
  /** Host-resolved isolated entry document, never a raw manifest path. */
  readonly entryUrl: string;
  /** Bridge methods the page may invoke; absent means render-only. */
  readonly declared?: readonly string[];
  readonly invoke?: BridgeInvoker;
}

export interface CustomPageProjectionOptions {
  /** Trusted host resolver for the package-relative entry path. */
  readonly resolveEntry: (entry: string, contribution: CustomPageManifestContribution) => string;
  readonly title?: (contribution: CustomPageManifestContribution) => string;
  readonly declared?: (contribution: CustomPageManifestContribution) => readonly string[] | undefined;
  readonly invoke?: BridgeInvoker;
}

/** Project manifest page contributions that carry an executable entry. A
 * declarative page has no entry document and is never treated as a custom
 * page. */
export function customPageDeclarations(manifest: CustomPageManifest, options: CustomPageProjectionOptions): CustomPageDeclaration[] {
  return (manifest.contributions ?? []).flatMap(contribution => {
    if (contribution.surface !== 'page' || contribution.runtime !== 'host' || !contribution.entry) return [];
    const declared = options.declared?.(contribution);
    return [{
      id: contribution.id,
      title: options.title?.(contribution) ?? manifest.name ?? manifest.id,
      entryUrl: options.resolveEntry(contribution.entry, contribution),
      ...(declared?.length ? {declared} : {}),
      ...(options.invoke ? {invoke: options.invoke} : {}),
    }];
  });
}

/** The one live bridge of a mounted custom page. `unmount` closes whatever
 * channel the page issued; `revoke` additionally fences every later attach,
 * so a late claim can never rebuild a channel after the page lost authority. */
export class CustomPageMount {
  #bridge: CustomPageBridge | null = null;
  #revoked = false;

  get active(): CustomPageBridge | null { return this.#bridge; }
  get revoked(): boolean { return this.#revoked; }

  attach(bridge: CustomPageBridge): void {
    if (this.#revoked) { bridge.revoke(); return; }
    if (this.#bridge && this.#bridge !== bridge) this.#bridge.revoke();
    this.#bridge = bridge;
  }

  unmount(): void {
    this.#bridge?.revoke();
    this.#bridge = null;
  }

  revoke(): void {
    this.#revoked = true;
    this.unmount();
  }
}

export interface CustomPageInstallation {
  readonly contributions: readonly WebContribution[];
  readonly mounts: ReadonlyMap<string, CustomPageMount>;
  /** Close every page channel in this installation; later claims are refused. */
  revoke(): void;
}

function CustomPageView({declaration, instanceId, lifetime, mount}: {
  declaration: CustomPageDeclaration;
  instanceId: string;
  lifetime: ViewLifetime;
  mount: CustomPageMount;
}) {
  const identity = useMemo(() => ({nonce: crypto.randomUUID(), documentKey: crypto.randomUUID()}), []);
  const visible = useCallback(() => lifetime.state === 'visible', [lifetime]);
  return <CustomPluginPage
    entryUrl={declaration.entryUrl}
    title={declaration.title}
    instanceId={instanceId}
    nonce={identity.nonce}
    documentKey={identity.documentKey}
    declared={declaration.declared}
    invoke={declaration.invoke}
    visible={visible}
    onBridgeChange={bridge => bridge ? mount.attach(bridge) : mount.unmount()}
  />;
}

/** Host-owned page entries for one plugin instance. The route includes the
 * instance so two instances of the same package never claim one page. */
export function customPageContributions(instance: {readonly instanceId: string; readonly packageId: string}, lifetime: ViewLifetime, declarations: readonly CustomPageDeclaration[]): CustomPageInstallation {
  const mounts = new Map<string, CustomPageMount>();
  const contributions = declarations.map((declaration, index): WebContribution => {
    const mount = new CustomPageMount();
    mounts.set(declaration.id, mount);
    return {
      surface: 'page',
      entry: {
        id: declaration.id,
        route: `plugin/${encodeURIComponent(instance.instanceId)}/${encodeURIComponent(declaration.id)}`,
        label: declaration.title,
        section: 'system',
        order: 1000 + index,
        featureId: instance.packageId,
        render: () => <CustomPageView declaration={declaration} instanceId={instance.instanceId} lifetime={lifetime} mount={mount}/>,
      },
    };
  });
  return {
    contributions,
    mounts,
    revoke() { for (const mount of mounts.values()) mount.revoke(); },
  };
}
