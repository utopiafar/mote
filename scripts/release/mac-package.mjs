import {readFileSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
if(process.platform!=='darwin')throw Error('Mac packaging requires macOS');
const pkg=JSON.parse(readFileSync('apps/desktop/package.json','utf8')),mode=process.env.MOTE_MAC_SIGNING_MODE||'adhoc';
const development=process.env.MOTE_MAC_DEVELOPMENT==='1';
const config=structuredClone(pkg.build);if(development){config.appId='dev.mote.collector.dev';config.productName='Mote Collector Dev';config.directories.output='release-dev';config.extraMetadata={moteDevelopment:true};}
const temp=join(tmpdir(),'mote-mac-release-'+randomUUID());mkdirSync(temp,{mode:0o700});
try{
  if(mode==='developer-id'){
    for(const key of ['CSC_LINK','CSC_KEY_PASSWORD','MOTE_APPLE_TEAM_ID','MOTE_APPLE_API_KEY_P8','APPLE_API_KEY_ID','APPLE_API_ISSUER'])if(!process.env[key])throw Error('Mac Developer ID signing and notarization secrets are required');
    delete config.mac.identity;config.forceCodeSigning=true;config.mac.notarize=true;
    writeFileSync(join(temp,'notarization.p8'),process.env.MOTE_APPLE_API_KEY_P8,{mode:0o600});process.env.APPLE_API_KEY=join(temp,'notarization.p8');
  }else if(mode==='adhoc'){config.mac.identity='-';config.mac.notarize=false;process.env.CSC_IDENTITY_AUTO_DISCOVERY='false';delete process.env.CSC_LINK;delete process.env.CSC_KEY_PASSWORD;}
  else throw Error('Unsupported Mac signing mode');
  writeFileSync(join(temp,'builder.json'),JSON.stringify(config));
  execFileSync('npm',['run','build','-w','@mote/desktop'],{stdio:'inherit'});
  execFileSync(resolve('node_modules/.bin/electron-builder'),['--dir','--config',join(temp,'builder.json'),'--'+process.arch],{cwd:resolve('apps/desktop'),stdio:'inherit',env:process.env});
  const app=resolve(`apps/desktop/${development?'release-dev':'release'}/${process.arch==='arm64'?'mac-arm64':'mac'}/${config.productName}.app`);
  execFileSync('codesign',['--verify','--deep','--strict',app],{stdio:'pipe'});
  const field=name=>execFileSync('/usr/libexec/PlistBuddy',['-c',`Print :${name}`,join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim();
  if(field('CFBundleIdentifier')!==config.appId||field('CFBundleShortVersionString')!==pkg.version)throw Error('Packaged Mac identity mismatch');
  execFileSync('lipo',[join(app,'Contents/MacOS',field('CFBundleExecutable')),'-verify_arch',process.arch==='x64'?'x86_64':'arm64'],{stdio:'pipe'});
  if(mode==='developer-id'){
    if(!/^[A-Z0-9]{10}$/.test(process.env.MOTE_APPLE_TEAM_ID))throw Error('Invalid Apple signing team');
    execFileSync('codesign',['--verify','--strict','-R',`anchor apple generic and certificate leaf[subject.OU] = "${process.env.MOTE_APPLE_TEAM_ID}"`,app],{stdio:'pipe'});
    execFileSync('xcrun',['stapler','validate',app],{stdio:'pipe'});execFileSync('spctl',['--assess','--type','execute',app],{stdio:'pipe'});
  }
  // Validate the actual packaged ESM dependencies and legacy data compatibility without opening the App.
  execFileSync(join(app,'Contents/MacOS',field('CFBundleExecutable')),[resolve('apps/desktop/scripts/packaged-metadata-smoke.cjs'),join(app,'Contents/Resources')],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  const zip=resolve(`artifacts/release/mote-desktop-macos-${development?'dev-':''}${process.arch}-${pkg.version}.zip`);mkdirSync(resolve('artifacts/release'),{recursive:true});if(existsSync(zip))rmSync(zip);
  execFileSync('ditto',['-c','-k','--sequesterRsrc','--keepParent',app,zip]);
  execFileSync(process.execPath,['scripts/release/asset-metadata.mjs','desktop',zip,process.arch],{stdio:'inherit',env:process.env});
}finally{rmSync(temp,{recursive:true,force:true});}
