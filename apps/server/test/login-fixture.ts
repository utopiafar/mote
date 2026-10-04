import type {Connections} from '../src/connections.js';
/** Agent credentials remain restricted even though paired human clients have full rights. */
export async function readAgentCredential(connections:Connections){
 const grant=await connections.mintMcp({serverUrl:'https://fixture.invalid',label:'Generated read-only query agent',access:'read'}, {directory:'unused',mcpEnabled:true});
 return {token:grant.config.mcpServers.mote.headers.Authorization.slice(7)};
}
