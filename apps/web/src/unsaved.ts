import {useEffect, useId} from 'react';
import {moteText} from '@mote/shared/i18n';
const drafts = new Set<string>();
export function confirmNavigation() {
  return drafts.size === 0 || window.confirm(moteText('有未保存的修改。离开并丢弃修改？'));
}
export function useUnsavedChanges(dirty: boolean) {
  const id = useId();
  useEffect(() => {
    if (dirty) drafts.add(id); else drafts.delete(id);
    const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => { drafts.delete(id); window.removeEventListener('beforeunload', unload); };
  }, [id, dirty]);
}
