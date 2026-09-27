/** Modal ownership is independent of selected evidence, so nested refs retain the original opener. */
export function containDialogFocus(panel:HTMLElement,previous:HTMLElement|null,preferred:HTMLElement|null=null){
 const document=panel.ownerDocument;
 const items=()=>Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]')).filter(el=>!el.closest('[hidden],[inert]')&&el.getClientRects().length>0);
 const beforeTabIndex=panel.getAttribute('tabindex');
 panel.tabIndex=-1;
 const focused=panel.contains(document.activeElement)?document.activeElement as HTMLElement:null;
 (preferred??focused??items()[0]??panel).focus({preventScroll:true});
 // aria-modal describes modality; inert enforces it for focus and the browser's
 // accessibility tree. Keep every ancestor of the dialog itself available.
 const background:HTMLElement[]=[];
 for(let branch:HTMLElement|null=panel;branch?.parentElement;branch=branch.parentElement){
  for(const sibling of Array.from(branch.parentElement.children)){
   if(sibling===branch||!(sibling instanceof document.defaultView!.HTMLElement)||sibling.hasAttribute('inert'))continue;
   sibling.setAttribute('inert','');background.push(sibling);
  }
  if(branch.parentElement===document.body)break;
 }
 const trap=(event:KeyboardEvent)=>{
  if(event.key!=='Tab'||panel.closest('[inert]'))return;
  const nodes=items(),first=nodes[0]??panel,last=nodes.at(-1)??panel;
  if(event.shiftKey&&(document.activeElement===first||!panel.contains(document.activeElement))){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&(document.activeElement===last||!panel.contains(document.activeElement))){event.preventDefault();first.focus();}
 };
 document.addEventListener('keydown',trap);
 return()=>{
  document.removeEventListener('keydown',trap);
  for(const element of background)element.removeAttribute('inert');
  if(beforeTabIndex===null)panel.removeAttribute('tabindex');else panel.setAttribute('tabindex',beforeTabIndex);
  if(previous?.isConnected)previous.focus({preventScroll:true});
 };
}
