import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'js-yaml'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const publicDefs = path.resolve(__dirname, '../public/defs')

const files = {
  dma: path.join(repoRoot, 'DMA.yaml'),
  activation: path.join(repoRoot, 'Activation.yaml'),
  ctrl: path.join(repoRoot, 'Control.yaml'),
  parameter: path.join(repoRoot, 'Parameter.yaml'),
  registers: path.join(repoRoot, 'registers.yaml'),
}

function fileSize(p) {
  try {
    return fs.statSync(p).size
  } catch {
    return -1
  }
}

function isEmptyOrMissing(p) {
  const size = fileSize(p)
  return size <= 0
}

function classifyGroupName(groupName) {
  const upper = groupName.toUpperCase()
  if (upper === 'DMA') {
    return 'dma'
  }
  if (upper.endsWith('_PARAM')) {
    return 'parameter'
  }
  if (upper.endsWith('_ACT')) {
    return 'activation'
  }
  return 'ctrl'
}

function splitRegistersYaml(content) {
  const parsed = YAML.load(content, { json: true })
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('registers.yaml 解析失败或内容为空')
  }

  const buckets = {
    dma: {},
    activation: {},
    ctrl: {},
    parameter: {},
  }

  for (const [groupName, registers] of Object.entries(parsed)) {
    if (!Array.isArray(registers)) {
      continue
    }
    const bucket = classifyGroupName(groupName)
    buckets[bucket][groupName] = registers
  }

  return buckets
}

function dumpYamlDocument(doc) {
  return `${YAML.dump(doc, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  }).replace(/\n+$/, '')}\n`
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function copyFile(src, dst) {
  fs.copyFileSync(src, dst)
}

function main() {
  ensureDir(publicDefs)

  const registersSize = fileSize(files.registers)
  if (registersSize <= 0) {
    throw new Error(`缺少或为空: ${files.registers}`)
  }

  const registersText = fs.readFileSync(files.registers, 'utf8')
  const extracted = splitRegistersYaml(registersText)

  for (const [kind, srcPath] of Object.entries(files)) {
    if (kind === 'registers') {
      continue
    }

    if (isEmptyOrMissing(srcPath)) {
      const doc = extracted[kind]
      if (Object.keys(doc).length === 0) {
        throw new Error(
          `无法从 registers.yaml 生成 ${path.basename(srcPath)}：没有匹配的分组（请检查命名规则）`,
        )
      }
      fs.writeFileSync(srcPath, dumpYamlDocument(doc), 'utf8')
      process.stdout.write(
        `Wrote ${path.basename(srcPath)} from registers.yaml (${Object.keys(doc).length} groups)\n`,
      )
    } else {
      process.stdout.write(`Using existing ${path.basename(srcPath)} (${fileSize(srcPath)} bytes)\n`)
    }

    copyFile(srcPath, path.join(publicDefs, path.basename(srcPath)))
  }

  process.stdout.write(`Copied YAML into ${publicDefs}\n`)
}

try {
  main()
} catch (error) {
  const message = error && error.message ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
}
