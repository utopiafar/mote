/** Preserve the owner's draft choices while one-time import temporarily requires all files. */
export function createSourceFilePolicyDraft(history: HTMLSelectElement, retention: HTMLSelectElement) {
  let savedHistory=history.value, oneTime=false;
  history.addEventListener('change',()=>{if(!oneTime)savedHistory=history.value;});
  return {
    setOneTime(value:boolean) {
      if(value!==oneTime){
        if(value){savedHistory=history.value;history.value='all';}
        else history.value=savedHistory;
        oneTime=value;
      }
      history.disabled=value;
    },
    reset() { oneTime=false;savedHistory='all';history.disabled=false;history.value='all';retention.value='snapshot'; },
  };
}
