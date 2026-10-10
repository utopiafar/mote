/** Owner questions live within Ask; identifiers never carry answer semantics. */
export function ownerQuestionRoute(id:string){return '#/ask?'+new URLSearchParams({question:id});}
export function readOwnerQuestion(hash:string){return new URLSearchParams(hash.split('?')[1]??'').get('question');}
export function ownerQuestionListPath(scope:{workId?:string;materialId?:string;operationIds?:string[]}={},cursor?:string,state='open,deferred'){
  const {operationIds,...ids}=scope;
  return '/api/owner-questions?'+new URLSearchParams({limit:'20',state,...ids,...operationIds?.length?{operationIds:JSON.stringify(operationIds.slice(0,100))}:{},...cursor?{cursor}:{}});
}
