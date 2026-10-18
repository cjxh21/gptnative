import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const cli=join(dirname(fileURLToPath(import.meta.url)),'..','native-cli.mjs')
const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8'})
test('--version prints a version and exits zero',()=>{
 for(const flag of ['--version','-v']){
  const r=run([flag]);assert.equal(r.status,0);assert.match(r.stdout,/^gptnative \d+\.\d+\.\d+\n$/);assert.equal(r.stderr,'')
 }
})
test('--version is not dispatched as an unknown command',()=>{
 const r=run(['--version']);assert.ok(!r.stdout.includes('Unknown command'));assert.ok(!r.stderr.includes('Unknown command'))
})
test('unknown commands are still rejected without touching credentials',()=>{
 const r=run(['definitely-not-a-command']);assert.notEqual(r.status,0);assert.match(r.stderr,/Unknown command/)
})
test('bare invocation and --help still print usage',()=>{
 for(const args of [[],['--help']]){const r=run(args);assert.equal(r.status,0);assert.match(r.stdout,/gptnative account/)}
})
