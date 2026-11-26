/** Keep live rows in the DOM when their peers update or move. */
export function updateListChildren(root: HTMLElement, children: readonly HTMLElement[]): void {
  const focused = root.ownerDocument.activeElement as HTMLElement | null;
  const kept = new Set<Node>(children);
  for (const child of Array.from(root.childNodes)) {
    if (!kept.has(child)) child.remove();
  }
  let cursor = root.firstChild;
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextSibling;
    else root.insertBefore(child, cursor);
  }
  if (focused && root.contains(focused) && root.ownerDocument.activeElement !== focused) {
    focused.focus({preventScroll:true});
  }
}
