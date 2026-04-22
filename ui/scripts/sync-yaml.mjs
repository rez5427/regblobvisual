import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const publicDefs = path.resolve(__dirname, '../public/defs')
const sourceRegisters = '/home/rez/workbench/cix/cnnc/cxn/registers.yaml'
const targetRegisters = path.join(repoRoot, 'registers.yaml')
const publicRegisters = path.join(publicDefs, 'registers.yaml')

function fileSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return -1
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function copyFile(src, dst) {
  fs.copyFileSync(src, dst)
}

function main() {
  ensureDir(publicDefs)

  if (fileSize(sourceRegisters) <= 0) {
    throw new Error(`缺少或为空: ${sourceRegisters}`)
  }

  copyFile(sourceRegisters, targetRegisters)
  copyFile(sourceRegisters, publicRegisters)
  process.stdout.write(`Synced registers.yaml from ${sourceRegisters}\n`)
  process.stdout.write(` -> ${targetRegisters} (${fileSize(targetRegisters)} bytes)\n`)
  process.stdout.write(` -> ${publicRegisters} (${fileSize(publicRegisters)} bytes)\n`)
}

try {
  main()
} catch (error) {
  const message = error && error.message ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
