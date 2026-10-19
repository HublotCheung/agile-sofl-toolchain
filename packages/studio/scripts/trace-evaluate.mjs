// Offline evaluation. No model call, credentials or network access is required.
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const [file,method='supplied',threshold='0.5']=process.argv.slice(2)
if(!file){console.error('Usage: node scripts/trace-evaluate.mjs dataset.json [supplied|name|vsm|embeddings] [threshold]');process.exitCode=1}
else{
  if(!['supplied','name','vsm','embeddings'].includes(method))throw new Error('Unknown evaluation method.')
  const result=await build({entryPoints:[fileURLToPath(new URL('../src/shared/traceEvaluation.ts',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs'})
  const module={exports:{}}
  new Function('module','exports',result.outputFiles[0].text)(module,module.exports)
  const dataset=JSON.parse(readFileSync(file,'utf8'))
  console.log(JSON.stringify(module.exports.evaluateTraceCases(dataset.cases,method,Number(threshold)),null,2))
}
