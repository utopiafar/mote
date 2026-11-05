/** 采集与设备属于来源；旧路由只做一次地址替换，不再保留旧页面。 */
export const devicePageRoute='sources/devices';
export const devicePageAliases:string[]=['connections/devices'];
export function redirectDeviceRoute(hash:string){
  const [route,query]=hash.replace(/^#\/?/,'').split('?');
  if(!devicePageAliases.includes(route))return;
  return '#/'+devicePageRoute+(query!==undefined?'?'+query:'');
}
