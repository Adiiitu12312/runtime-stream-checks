import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { freemem } from 'node:os';
const MiB = 1024 ** 2;
mkdirSync('results', { recursive: true });
const docker = (args, timeout = 60000) => spawnSync('docker', args, { encoding:'utf8', timeout, maxBuffer: 4 * MiB });
const checked = args => { const r = docker(args); if (r.error || r.status !== 0) throw new Error(JSON.stringify({args, status:r.status, error:r.error?.message, stderr:r.stderr})); return r.stdout.trim(); };
const cases = [
 ['small', 'data', 8, 'default', 256, 'success'],
 ['boundary', 'data', 4, '4', 256, 'success'],
 ['over-limit', 'data', 8, '4', 256, 'size-error'],
 ['larger', 'data', 128, 'default', 512, 'success'],
 ['configured', 'data', 128, '100', 512, 'size-error'],
 ['blob', 'blob', 8, 'default', 256, 'success'],
 ['budget', 'data', 160, 'default', 256, 'observe'],
 ['native-control', 'native', 160, 'default', 256, 'observe'],
 ['budget-configured', 'data', 160, '100', 256, 'size-error'],
 ['lower-budget', 'data', 96, 'default', 192, 'observe'],
 ['lower-budget-configured', 'data', 96, '100', 192, 'observe'],
];
const results = []; let failures = 0;
for (const image of ['node:24-bookworm-slim', 'node:26-bookworm-slim']) {
 checked(['pull', image]);
 const imageId = checked(['image','inspect',image,'--format','{{.Id}}']);
 for (const [name,mode,size,limit,budget,expectation] of cases) {
  if (freemem() < (budget + 1024) * MiB) throw new Error('Runner free-memory preflight failed');
  const id = checked(['create','--memory',`${budget}m`,'--memory-swap',`${budget}m`,'--network','none','--cpus','1','--pids-limit','64','--read-only','--tmpfs','/tmp:rw,size=16m','--cap-drop','ALL','--security-opt','no-new-privileges','--mount',`type=bind,src=${resolve('runtime')},dst=/app,readonly`,image,'node','--max-old-space-size=64','--expose-gc','/app/workload.mjs',mode,String(size),limit,String(budget)]);
  let record;
  try {
   const configured = JSON.parse(checked(['inspect', id]))[0].HostConfig;
   if(configured.Memory !== budget * MiB || configured.MemorySwap !== budget * MiB || configured.NetworkMode !== 'none') throw new Error('Container limit verification failed');
   const start = docker(['start','--attach',id], 30000);
   const timedOut = !!start.error;
   if(timedOut) checked(['kill',id]);
   const state = JSON.parse(checked(['inspect',id]))[0].State;
   const logs = docker(['logs',id]);
   const lines = logs.stdout.trim().split('\n').flatMap(line => {try{return [JSON.parse(line)];}catch{return [];}});
   const output = lines.find(line=>line.event === 'result');
   let classification = timedOut ? 'deadline' : state.OOMKilled ? 'cgroup-oom' : output?.outcome.kind === 'success' ? 'success' : output?.outcome.kind === 'caught' ? 'caught' : /FATAL ERROR.*heap|Reached heap limit/.test(logs.stderr) ? 'v8-fatal' : 'unclassified';
   const validStart = lines.some(line=>line.event==='start' && line.budget===budget*MiB);
   const sizeError = output?.outcome.name === 'AI_DownloadError' && /exceeds|exceeded|maximum|maxBytes|size limit/i.test(output.outcome.message);
   const pass = validStart && !timedOut && (expectation === 'observe' ? classification !== 'unclassified' : expectation === 'success' ? classification==='success' && output.outcome.bytes===size*MiB : classification==='caught' && sizeError);
   if(!pass) failures++;
   record = {image,imageId,name,mode,sizeMiB:size,limitMiB:limit,budgetMiB:budget,expectation,classification,pass,state,output,stdout:logs.stdout,stderr:logs.stderr};
   results.push(record); writeFileSync(`results/${image.split(':')[1]}-${name}.json`,JSON.stringify(record,null,2));
   console.log(JSON.stringify({image,name,classification,pass,consumed:output?.consumed,peak:output?.peak,state}));
  } finally { checked(['rm','--force',id]); }
 }
}
writeFileSync('results/summary.json',JSON.stringify(results,null,2));
if(process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '| Runtime | Sample | Outcome | Check |\n|---|---|---|---|\n'+results.map(r=>`|${r.image}|${r.name}|${r.classification}|${r.pass?'pass':'FAIL'}|`).join('\n')+'\n');
if(failures) process.exitCode=1;
