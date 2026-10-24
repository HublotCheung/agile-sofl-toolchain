/**
 * Launch Studio in English and light mode, open a project, and write screenshots.
 *
 *   node scripts/capture-paper-shots.mjs --project "D:/asfl/DAM"
 *
 * Output defaults to the paper repo's figures/screenshots/captured.
 * Requires `npx electron-vite dev` to be able to start (dependencies already installed).
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const studio = path.resolve(here, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return fallback
}

const project = arg('--project', 'D:/asfl/DAM')
const outDir = arg(
  '--out',
  'D:/ECNU/research/agile-sofl-paper/agile-sofl-paper/figures/screenshots/captured'
)
mkdirSync(outDir, { recursive: true })

const userData = path.join(tmpdir(), `agile-sofl-paper-capture-${Date.now()}`)
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })
const env = {
  ...process.env,
  STUDIO_CAPTURE: '1',
  STUDIO_CAPTURE_KIND: 'paper',
  STUDIO_CAPTURE_DIR: outDir,
  STUDIO_CAPTURE_PROJECT: project,
  STUDIO_CAPTURE_USER_DATA: userData
}

console.log(`[capture-paper-shots] project ${project}`)
console.log(`[capture-paper-shots] out ${outDir}`)
console.log('[capture-paper-shots] dev server, English, light, HMR off')

const child = spawn('npx', ['electron-vite', 'dev'], {
  cwd: studio,
  env,
  stdio: 'inherit',
  shell: true
})
child.on('exit', (code) => process.exit(code ?? 1))
