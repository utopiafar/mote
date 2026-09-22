import {constants,closeSync,chmodSync,fchmodSync,fstatSync,lstatSync,mkdirSync,openSync} from 'node:fs';

const owned=(uid:number)=>!process.getuid||uid===process.getuid();

/** mkdir's mode does not protect a pre-existing bind mount or restored vault. */
export function privateDirectory(directory:string) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const info=lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink()||!owned(info.uid))throw new Error('Private storage requires an owned directory, not a symbolic link');
  const fd=openSync(directory,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened=fstatSync(fd);
    if(!opened.isDirectory()||!owned(opened.uid)||opened.dev!==info.dev||opened.ino!==info.ino)throw new Error('Private storage directory changed');
    fchmodSync(fd,0o700);
  }finally{closeSync(fd);}
}

/** Validate before SQLite can follow an existing database or journal link. */
export function privateFile(path:string,create=false) {
  let fd:number;
  try{fd=openSync(path,constants.O_RDWR|constants.O_NOFOLLOW|(create?constants.O_CREAT:0),0o600);}
  catch(error){if(!create&&(error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  try {
    const info=fstatSync(fd);
    if(!info.isFile()||info.nlink!==1||!owned(info.uid))throw new Error('Private storage requires an owned regular file with one link');
    fchmodSync(fd,0o600);
  }finally{closeSync(fd);}
}

/** Never open/close an existing SQLite database or sidecar outside SQLite. On
 * POSIX, close() releases every process lock on that inode, including locks held
 * by another SQLite connection. A later opener can then truncate a live WAL map.
 * The containing directory is already verified owned/private by the caller. */
export function privateSqliteFile(path:string,create=false) {
  let info:ReturnType<typeof lstatSync>;
  try{info=lstatSync(path);}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    if(!create)return;
    try{const fd=openSync(path,constants.O_RDWR|constants.O_NOFOLLOW|constants.O_CREAT|constants.O_EXCL,0o600);closeSync(fd);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    info=lstatSync(path);
  }
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||!owned(info.uid))throw new Error('Private storage requires an owned regular file with one link');
  if((info.mode&0o777)!==0o600)chmodSync(path,0o600);
  const current=lstatSync(path);
  if(!current.isFile()||current.isSymbolicLink()||current.nlink!==1||!owned(current.uid)||current.dev!==info.dev||current.ino!==info.ino)throw new Error('Private SQLite storage changed');
}
