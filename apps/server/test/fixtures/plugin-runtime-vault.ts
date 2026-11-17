import type {Store} from '../../src/store.js';
import {createVaultPlatformAssembly} from '../../src/plugins/vault-platform.js';

/** Test-only borrowed-store Vault assembly for host-bound auth/execution factories. */
export async function testVault(store:Store,directory=store.directory){
  const vault=createVaultPlatformAssembly({dataDir:directory},{store});
  await vault.prepare();
  return vault;
}
