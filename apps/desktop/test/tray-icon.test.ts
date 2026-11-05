import {describe,expect,it} from 'vitest';
import {resolve} from 'node:path';
import sharp from 'sharp';
import {trayIconName,type TrayIconStatus} from '../src/tray-icon';

const capturing:TrayIconStatus={
  running:true,
  state:'capturing',
  screenPermission:'granted',
  sync:{state:'idle',pendingRecords:0},
  config:{serverUrl:'https://central.example',tokenConfigured:true,syncPaused:false},
};

describe('tray icon selection',()=>{
  it('uses the normal template while capturing',()=>{
    expect(trayIconName(capturing)).toBe('moteNormalTemplate.png');
  });

  it('uses the paused template after capture stops',()=>{
    expect(trayIconName({...capturing,running:false,state:'stopped'})).toBe('motePausedTemplate.png');
  });

  it('uses the alert template when capture needs permission',()=>{
    expect(trayIconName({...capturing,state:'permission_required',screenPermission:'denied'})).toBe('moteAlertTemplate.png');
  });

  it('lets the shared needs-action mapping win over a temporary pause',()=>{
    expect(trayIconName({...capturing,state:'paused',sync:{state:'error',pendingRecords:1}})).toBe('moteAlertTemplate.png');
  });

  it('ships one 18-point template and Retina counterpart for each state',async()=>{
    for(const name of ['moteNormalTemplate','motePausedTemplate','moteAlertTemplate']){
      for(const scale of [1,2]){
        const image=sharp(resolve(__dirname,`../resources/tray/${name}${scale===2?'@2x':''}.png`));
        const metadata=await image.metadata();
        expect(metadata.width).toBe(18*scale);
        expect(metadata.height).toBe(18*scale);
        expect(metadata.channels).toBe(4);
      }
    }
  });
});
