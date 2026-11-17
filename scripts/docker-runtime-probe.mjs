import {readConfigDocument} from '@mote/shared/config-file';

const route=process.argv[2],timeout=Number(process.argv[3]);
if(!['/api/status','/api/health'].includes(route)||!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)throw Error('Invalid deployment probe');
const {server}=readConfigDocument(process.env.MOTE_CONFIG_FILE).document;
const response=await fetch(`http://127.0.0.1:${server.port}${route}`,{headers:{Authorization:`Bearer ${server.token}`},redirect:'error',signal:AbortSignal.timeout(timeout)});
if(!response.ok)throw Error(`Deployment probe returned HTTP ${response.status}`);
console.log(JSON.stringify(await response.json()));
