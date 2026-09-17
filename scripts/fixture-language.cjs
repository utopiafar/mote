// Existing synthetic UI fixtures assert Chinese copy independently of the host OS.
const {app}=require('electron');
app.getPreferredSystemLanguages=()=>['zh-CN'];
const sessions=new WeakSet();
app.on('browser-window-created',(_event,window)=>{
 const session=window.webContents.session;
 if(sessions.has(session))return;
 sessions.add(session);
 session.registerPreloadScript({type:'frame',filePath:require('node:path').join(__dirname,'fixture-language-preload.cjs')});
});
