import {webAppearance} from './appearance';
import { UiPresentationHost, applyAppearanceTheme, desktopUiLayout, linearUiTheme, type UiLayoutProfile } from '@mote/shared';
import React, { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { revealWorkspaceFocus } from './workspace-focus';
import { moteText } from '@mote/shared/i18n';

/** Trusted, compiled renderers receive presentation slots, never control session or job lifetimes. */
export type WebShellProps = {
  layout: UiLayoutProfile;
  navigation: ReactNode;
  toolbar: ReactNode;
  footer: ReactNode;
  content: ReactNode;
};
export type WebShellRenderer = React.ComponentType<WebShellProps>;

export function WorkspaceShell({ layout, navigation, toolbar, content, footer }: WebShellProps) {
  return <div className="app-shell" data-navigation={layout.navigation} data-detail={layout.detail}>
    {navigation}
    <main className="main" onFocusCapture={event => revealWorkspaceFocus(event.target)}>
      {toolbar}{content}{footer}
    </main>
  </div>;
}

export const webPresentation = new UiPresentationHost<WebShellRenderer>({
  theme: linearUiTheme,
  layout: { ...desktopUiLayout, implementation: WorkspaceShell },
});

/** Moving this stable portal container preserves fields, React state and pending work across shells. */
function ContentOutlet({ container }: { container: HTMLElement }) {
  const target = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { target.current?.appendChild(container); }, [container]);
  return <div ref={target} className="presentation-content-outlet"/>;
}

class ShellBoundary extends React.Component<{ renderer: WebShellRenderer; slots: WebShellProps }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    const Renderer = this.state.failed ? WorkspaceShell : this.props.renderer;
    return <><Renderer {...this.props.slots}/>{this.state.failed&&<p role="status" className="notice">{moteText('专用视图暂不可用，请查看资料库或重试。')}</p>}</>;
  }
}

export function PresentationSurface({ navigation, toolbar, footer, children, host = webPresentation }: {
  navigation: (layout: UiLayoutProfile) => ReactNode;
  toolbar: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  host?: UiPresentationHost<WebShellRenderer>;
}) {
  const appearance = useSyncExternalStore(webAppearance.subscribe,webAppearance.getSnapshot,webAppearance.getSnapshot);
  const restore = useRef<{ focus: HTMLElement | null; x: number; y: number } | undefined>(undefined);
  const snapshot = useSyncExternalStore(listener => host.subscribe(() => {
    restore.current = { focus: document.activeElement as HTMLElement | null, x: window.scrollX, y: window.scrollY };
    listener();
  }), host.getSnapshot, host.getSnapshot);
  const [container] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    const root = document.documentElement;
    const restoreTheme=applyAppearanceTheme(root,snapshot.theme,appearance.scheme);
    root.dataset.uiTheme = snapshot.theme.id;
    root.dataset.uiLayout = snapshot.layout.id;
    const previousThemeLabel=root.dataset.uiThemeLabel,previousLayoutLabel=root.dataset.uiLayoutLabel;
    if(snapshot.themePresentation)root.dataset.uiThemeLabel=snapshot.themePresentation.label.text;else delete root.dataset.uiThemeLabel;
    if(snapshot.layoutPresentation)root.dataset.uiLayoutLabel=snapshot.layoutPresentation.label.text;else delete root.dataset.uiLayoutLabel;
    const saved = restore.current;
    if (saved) {
      if (saved.focus?.isConnected) saved.focus.focus({ preventScroll: true });
      window.scrollTo(saved.x, saved.y);
      restore.current = undefined;
    }
    return () => {
      restoreTheme();
      if(previousThemeLabel===undefined)delete root.dataset.uiThemeLabel;else root.dataset.uiThemeLabel=previousThemeLabel;
      if(previousLayoutLabel===undefined)delete root.dataset.uiLayoutLabel;else root.dataset.uiLayoutLabel=previousLayoutLabel;
    };
  }, [snapshot,appearance]);
  return <>
    <ShellBoundary key={snapshot.layout.id+'@'+snapshot.layout.version} renderer={snapshot.layout.implementation} slots={{layout:snapshot.layout,navigation:navigation(snapshot.layout),toolbar,footer,content:<ContentOutlet container={container}/>}}/>
    {createPortal(children, container)}
    {snapshot.fallbackReason&&<p role="status" className="notice presentation-notice">{moteText('专用视图暂不可用，请查看资料库或重试。')}{snapshot.fallbackPresentation&&' · '+snapshot.fallbackPresentation.label.text}</p>}
  </>;
}
