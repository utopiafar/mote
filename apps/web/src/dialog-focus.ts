/** Modal ownership is independent of the selected evidence, so nested refs retain the original opener. */
export function containDialogFocus(panel:HTMLElement,previous:HTMLElement|null){
 const document=panel.ownerDocument;
 const items=()=>Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(el=>!el.closest('[hidden],[inert]')&&el.getClientRects().length>0);
 panel.tabIndex=-1;(items()[0]??panel).focus({preventScroll:true});
 const trap=(event:KeyboardEvent)=>{if(event.key!=='Tab')return;const nodes=items(),first=nodes[0]??panel,last=nodes.at(-1)??panel;
  if(event.shiftKey&&(document.activeElement===first||!panel.contains(document.activeElement))){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!panel.contains(document.activeElement))){event.preventDefault();first.focus();}
 };
 document.addEventListener('keydown',trap);
 return()=>{document.removeEventListener('keydown',trap);if(previous?.isConnected)previous.focus({preventScroll:true});};
}
