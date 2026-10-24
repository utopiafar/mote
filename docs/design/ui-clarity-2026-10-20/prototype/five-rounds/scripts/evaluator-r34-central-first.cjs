const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {openCandidate}=require('./browser-session.cjs');
const {saveEvidence}=require('./evaluator-evidence.cjs');
const root=path.resolve(__dirname,'..');
const hashes={web:'33d63d9f009693fab234ebb37179da858b403e8a71c7e59624d4c9dcbd13d000',mac:'80520ac7f5d12fc494b5ffd1853c2039aa4f9fa9b3b8ac14d74e06cfe602160a',android:'c4f9e515adc7159809536466a3bc02f107dadda56c68b6f73e79d22076fdebb4'};
(async()=>{
 for(const platform of Object.keys(hashes)){
  const file=path.join(root,'rounds/r34',platform+'.html');
  const actual=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  if(actual!==hashes[platform])throw new Error('Candidate identity mismatch: '+platform);
 }
 for(const platform of Object.keys(hashes)){
  const session=await openCandidate(path.join(root,'rounds/r34',platform+'.html'),{viewport:platform==='android'?{width:412,height:915}:{width:1440,height:1000}});
  try {
   const snapshot=await saveEvidence(session.page,path.join(root,'rounds/r34/reports/central-independent/evidence/first-look'),platform);
   console.log(JSON.stringify({platform,candidate_sha256:hashes[platform],browser:session.browser.version(),errors:session.errors,...snapshot}));
  }finally{await session.browser.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
