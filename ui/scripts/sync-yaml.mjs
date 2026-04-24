import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const publicDefs = path.resolve(__dirname, '../public/defs')
const targetRegisters = path.join(repoRoot, 'registers.yaml')
const publicRegisters = path.join(publicDefs, 'registers.yaml')

function fileSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return -1
  }
}

function isNonEmpty(p) {
  return fileSize(p) > 0
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function copyFile(src, dst) {
  fs.copyFileSync(src, dst)
}

function main() {
  ensureDir(publicDefs)

  if (isNonEmpty(targetRegisters)) {
    copyFile(targetRegisters, publicRegisters)
    process.stdout.write(
      `sync-yaml: ${targetRegisters} (${fileSize(targetRegisters)} bytes) -> ${publicRegisters}\n`,
    )
    return
  }

  if (isNonEmpty(publicRegisters)) {
    copyFile(publicRegisters, targetRegisters)
    process.stdout.write(
      `sync-yaml: no root registers.yaml; copied ${publicRegisters} (${fileSize(publicRegisters)} bytes) -> ${targetRegisters}\n`,
    )
    return
  }

  throw new Error(`registers.yaml missing: add ${targetRegisters} or ${publicRegisters}`)
}

try {
  main()
} catch (error) {
  const message = error && error.message ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
