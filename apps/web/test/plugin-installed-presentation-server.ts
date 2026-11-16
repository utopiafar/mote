import {desktopUiLayout,linearUiTheme} from '@mote/shared';
import {unzipSync} from 'fflate';
import {pluginPresentationFixture,packedPresentationTemplate,presentationRelease} from '../../server/test/fixtures/plugin-presentation.js';

const webRoot=process.argv[2];if(!webRoot)throw Error('A built Web directory is required');
const fixture=await pluginPresentationFixture(webRoot);
try{
  const complete=await packedPresentationTemplate(fixture.directory),theme={...linearUiTheme,id:'generated.browser.theme',schemes:undefined,tokens:{...linearUiTheme.tokens,accent:'#aabbcc'}},layout={...desktopUiLayout,id:'generated.browser.layout',primary:[...desktopUiLayout.primary].reverse(),navigation:'top' as const,detail:'stack' as const};
  const manifest={...complete.manifest,contributions:[...complete.manifest.contributions!,{id:'generated.browser.theme',version:'1',surface:'theme' as const,runtime:'host' as const,entry:'theme.json',capabilities:['generated.theme']},{id:'generated.browser.layout',version:'1',surface:'layout' as const,runtime:'host' as const,entry:'layout.json',capabilities:['generated.layout']}],capabilities:[...complete.manifest.capabilities,'generated.theme','generated.layout']};
  const templatePackage=await fixture.install(presentationRelease(manifest,{...unzipSync(complete.archive),'theme.json':JSON.stringify(theme),'layout.json':JSON.stringify(layout)})),template=await fixture.configure(templatePackage);
  if((await fixture.check(template.id)).observed!=='ready'||(await fixture.enable(template.id)).observed!=='ready')throw Error('Complete presentation template did not enable');
  const origin=await fixture.node.app.listen({host:'127.0.0.1',port:0}),installed=fixture.node.pluginCenter.presentationInventory().instances.find(value=>value.instanceId===template.id)!;
  console.log(JSON.stringify({origin,token:fixture.config.token,templatePackage,templateInstance:template.id,pageId:installed.pages[0]!.id,pageTitle:installed.pages[0]!.title,activationId:installed.activationId}));
  let closing=false;const close=async()=>{if(closing)return;closing=true;await fixture.close();process.exit(0);};
  process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
}catch(error){await fixture.close();throw error;}
