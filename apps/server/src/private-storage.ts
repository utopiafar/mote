import {constants,closeSync,fchmodSync,fstatSync,lstatSync,mkdirSync,openSync} from 'node:fs';

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
