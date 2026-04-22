import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Collapse,
  Divider,
  Flex,
  InputNumber,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd'
import { UploadOutlined } from '@ant-design/icons'
import YAML from 'js-yaml'
import './App.css'

const { Title, Text } = Typography

type Endianness = 'little' | 'big'

type FieldSpec = {
  name: string
  bits?: number[]
  default?: number
}

type RegisterSpec = {
  name: string
  args?: FieldSpec[]
}

type GroupSpec = Record<string, RegisterSpec[]>
type BlobTypeName = 'dma' | 'activation' | 'ctrl' | 'parameter'
type BlobTypeMap = Record<BlobTypeName, GroupSpec>
type RegisterOffsetMap = Record<string, number>

type RegisterEntry = {
  key: string
  groupName: string
  registerName: string
  registerIndex: number
  offset: number
  fields: FieldSpec[]
}

function normalizeBits(bits: number[] | undefined): { start: number; end: number } {
  if (!bits || bits.length === 0) {
    return { start: 0, end: 31 }
  }
  if (bits.length === 1) {
    return { start: bits[0], end: bits[0] }
  }
  return { start: Math.min(bits[0], bits[1]), end: Math.max(bits[0], bits[1]) }
}

function parseGroupSpecFromYaml(content: string, label: string): GroupSpec {
  const parsed = YAML.load(content, { json: true })
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`${label}: YAML 内容为空或格式不正确`)
  }
  return parsed as GroupSpec
}

async function fetchYamlText(url: string, label: string): Promise<string> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`${label}: 无法加载 (${response.status} ${response.statusText})`)
  }
  const text = await response.text()
  if (!text.trim()) {
    throw new Error(`${label}: 文件为空`)
  }
  return text
}

async function loadBlobTypeDefinitions(): Promise<BlobTypeMap> {
  const dmaText = await fetchYamlText('/defs/DMA.yaml', 'DMA.yaml')
  const activationText = await fetchYamlText('/defs/Activation.yaml', 'Activation.yaml')
  const controlText = await fetchYamlText('/defs/Control.yaml', 'Control.yaml')
  const parameterText = await fetchYamlText('/defs/Parameter.yaml', 'Parameter.yaml')

  return {
    dma: parseGroupSpecFromYaml(dmaText, 'DMA.yaml'),
    activation: parseGroupSpecFromYaml(activationText, 'Activation.yaml'),
    ctrl: parseGroupSpecFromYaml(controlText, 'Control.yaml'),
    parameter: parseGroupSpecFromYaml(parameterText, 'Parameter.yaml'),
  }
}

async function loadRegisterOffsetMap(): Promise<RegisterOffsetMap> {
  const response = await fetch('/defs/aite-reg-map.json', { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`aite-reg-map.json: 无法加载 (${response.status} ${response.statusText})`)
  }
  const parsed = (await response.json()) as Record<string, unknown>
  const map: RegisterOffsetMap = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      map[k] = v
    }
  }
  return map
}

function flattenRegisters(groupSpec: GroupSpec, offsetMap?: RegisterOffsetMap): RegisterEntry[] {
  const entries: RegisterEntry[] = []
  let registerIndex = 0
  for (const [groupName, registers] of Object.entries(groupSpec)) {
    if (!Array.isArray(registers)) {
      continue
    }
    for (const reg of registers) {
      const regObj = reg as RegisterSpec
      entries.push({
        key: `${groupName}:${String(regObj.name)}:${registerIndex}`,
        groupName,
        registerName: String(regObj.name),
        registerIndex,
        offset:
          offsetMap?.[String(regObj.name).toUpperCase()] !== undefined
            ? offsetMap[String(regObj.name).toUpperCase()]
            : registerIndex * 4,
        fields: Array.isArray(regObj.args) ? regObj.args : [],
      })
      registerIndex += 1
    }
  }
  return entries
}

function readWord(bytes: Uint8Array, offset: number, endianness: Endianness): number {
  if (offset + 4 > bytes.length) {
    return 0
  }
  if (endianness === 'little') {
    return (
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)
    ) >>> 0
  }
  return (
    bytes[offset + 3] |
    (bytes[offset + 2] << 8) |
    (bytes[offset + 1] << 16) |
    (bytes[offset] << 24)
  ) >>> 0
}

function writeWord(
  bytes: Uint8Array,
  offset: number,
  value: number,
  endianness: Endianness,
): void {
  if (endianness === 'little') {
    bytes[offset] = value & 0xff
    bytes[offset + 1] = (value >>> 8) & 0xff
    bytes[offset + 2] = (value >>> 16) & 0xff
    bytes[offset + 3] = (value >>> 24) & 0xff
    return
  }
  bytes[offset + 3] = value & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset] = (value >>> 24) & 0xff
}

function getFieldValue(word: number, field: FieldSpec): number {
  const { start, end } = normalizeBits(field.bits)
  const width = end - start + 1
  const mask = ((1n << BigInt(width)) - 1n) << BigInt(start)
  return Number((BigInt(word) & mask) >> BigInt(start))
}

function setFieldValue(word: number, field: FieldSpec, fieldValue: number): number {
  const { start, end } = normalizeBits(field.bits)
  const width = end - start + 1
  const baseMask = (1n << BigInt(width)) - 1n
  const shiftedMask = baseMask << BigInt(start)
  const clamped = Math.max(0, Math.min(fieldValue, Number(baseMask)))
  const nextWord =
    (BigInt(word) & ~shiftedMask & 0xffffffffn) |
    ((BigInt(clamped) & baseMask) << BigInt(start))
  return Number(nextWord & 0xffffffffn)
}

function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`
}

const LOCAL_STATE_KEY = 'regblobvisual:lastState:v1'

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '==='.slice((base64.length + 3) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

function encodeSharePayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  const bytes = new TextEncoder().encode(json)
  return bytesToBase64Url(bytes)
}

function decodeSharePayload(raw: string): Record<string, unknown> {
  const bytes = base64UrlToBytes(raw)
  const text = new TextDecoder().decode(bytes)
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('分享链接内容无效')
  }
  return parsed as Record<string, unknown>
}

async function computeBlobHash(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digestInput = new Uint8Array(bytes).buffer
    const digest = await globalThis.crypto.subtle.digest('SHA-256', digestInput)
    const hashHex = Array.from(new Uint8Array(digest))
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
    return hashHex
  }

  // Fallback for older/insecure contexts where subtle crypto is unavailable.
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a_${hash.toString(16).padStart(8, '0')}`
}

function parseMaybeHexInput(raw: string | undefined): number {
  if (!raw) {
    return 0
  }
  const text = raw.trim().toLowerCase()
  if (text.startsWith('0x')) {
    const hex = text.slice(2).replace(/[^0-9a-f]/g, '')
    return hex ? parseInt(hex, 16) : 0
  }
  const dec = text.replace(/[^\d]/g, '')
  return dec ? Number(dec) : 0
}

function toSafeUint(value: number | string | null | undefined, max: number): number {
  if (value === null || value === undefined || value === '') {
    return 0
  }
  const asNumber = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(asNumber)) {
    return 0
  }
  const clamped = Math.max(0, Math.min(Math.trunc(asNumber), max))
  return clamped >>> 0
}

function App() {
  const [blobTypeName, setBlobTypeName] = useState<BlobTypeName>('dma')
  const [endianness, setEndianness] = useState<Endianness>('little')
  const [binaryBytesA, setBinaryBytesA] = useState<Uint8Array>()
  const [binaryBytesB, setBinaryBytesB] = useState<Uint8Array>()
  const [wordValuesA, setWordValuesA] = useState<number[]>([])
  const [wordValuesB, setWordValuesB] = useState<number[]>([])
  const [fileNameA, setFileNameA] = useState<string>('edited_blob.bin')
  const [fileHashA, setFileHashA] = useState<string>()
  const [fileHashB, setFileHashB] = useState<string>()
  const [shareUrl, setShareUrl] = useState<string>()
  const [blobTypes, setBlobTypes] = useState<BlobTypeMap>({
    dma: {},
    activation: {},
    ctrl: {},
    parameter: {},
  })
  const [registerOffsetMap, setRegisterOffsetMap] = useState<RegisterOffsetMap>({})
  const [definitionsLoading, setDefinitionsLoading] = useState(true)
  const [definitionsError, setDefinitionsError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setDefinitionsLoading(true)
      setDefinitionsError(undefined)
      try {
        const next = await loadBlobTypeDefinitions()
        const offsetMap = await loadRegisterOffsetMap()
        if (!cancelled) {
          setBlobTypes(next)
          setRegisterOffsetMap(offsetMap)
        }
      } catch (error) {
        if (!cancelled) {
          setDefinitionsError((error as Error).message)
          message.error((error as Error).message)
        }
      } finally {
        if (!cancelled) {
          setDefinitionsLoading(false)
        }
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const hash = window.location.hash
    if (!hash.startsWith('#s=')) {
      return
    }
    try {
      const encoded = hash.slice(3)
      const payload = decodeSharePayload(encoded)
      const payloadBlobType = payload.t
      const payloadEndian = payload.e
      const payloadA = payload.a
      const payloadB = payload.b
      const payloadNameA = payload.nA

      if (
        (payloadBlobType === 'dma' ||
          payloadBlobType === 'activation' ||
          payloadBlobType === 'ctrl' ||
          payloadBlobType === 'parameter') &&
        (payloadEndian === 'little' || payloadEndian === 'big') &&
        typeof payloadA === 'string'
      ) {
        setBlobTypeName(payloadBlobType)
        setEndianness(payloadEndian)
        setBinaryBytesA(base64UrlToBytes(payloadA))
        setFileNameA(typeof payloadNameA === 'string' ? payloadNameA : 'shared_blob_a_edited.bin')
        if (typeof payloadB === 'string' && payloadB.length > 0) {
          setBinaryBytesB(base64UrlToBytes(payloadB))
        }
        setShareUrl(window.location.href)
        message.success('已从分享链接恢复 A/B blob')
      }
    } catch (error) {
      message.error(`分享链接解析失败: ${(error as Error).message}`)
    }
  }, [])

  useEffect(() => {
    try {
      const cached = localStorage.getItem(LOCAL_STATE_KEY)
      if (!cached) {
        return
      }
      const payload = JSON.parse(cached) as Record<string, unknown>
      if (!payload || typeof payload !== 'object') {
        return
      }
      const payloadBlobType = payload.t
      const payloadEndian = payload.e
      const payloadA = payload.a
      const payloadB = payload.b
      if (
        (payloadBlobType === 'dma' ||
          payloadBlobType === 'activation' ||
          payloadBlobType === 'ctrl' ||
          payloadBlobType === 'parameter') &&
        (payloadEndian === 'little' || payloadEndian === 'big')
      ) {
        setBlobTypeName(payloadBlobType)
        setEndianness(payloadEndian)
      }
      if (typeof payloadA === 'string' && payloadA.length > 0) {
        setBinaryBytesA(base64UrlToBytes(payloadA))
      }
      if (typeof payloadB === 'string' && payloadB.length > 0) {
        setBinaryBytesB(base64UrlToBytes(payloadB))
      }
      if (typeof payload.nA === 'string') {
        setFileNameA(payload.nA)
      }
      if (typeof payload.hA === 'string') {
        setFileHashA(payload.hA)
      }
      if (typeof payload.hB === 'string') {
        setFileHashB(payload.hB)
      }
    } catch {
      // ignore invalid cache payload
    }
  }, [])

  useEffect(() => {
    if (!binaryBytesA && !binaryBytesB) {
      return
    }
    const payload = {
      t: blobTypeName,
      e: endianness,
      a: binaryBytesA ? bytesToBase64Url(binaryBytesA) : '',
      b: binaryBytesB ? bytesToBase64Url(binaryBytesB) : '',
      nA: fileNameA,
      hA: fileHashA ?? '',
      hB: fileHashB ?? '',
    }
    try {
      localStorage.setItem(LOCAL_STATE_KEY, JSON.stringify(payload))
    } catch {
      // local cache may fail due to browser quota limits
    }
  }, [binaryBytesA, binaryBytesB, blobTypeName, endianness, fileNameA, fileHashA, fileHashB])

  const currentGroupSpec = useMemo(() => {
    return blobTypes[blobTypeName]
  }, [blobTypeName, blobTypes])

  const registerEntries = useMemo(
    () => flattenRegisters(currentGroupSpec, registerOffsetMap),
    [currentGroupSpec, registerOffsetMap],
  )

  const expectedSize = registerEntries.length * 4

  useEffect(() => {
    if (!binaryBytesA) {
      return
    }
    if (registerEntries.length === 0) {
      setWordValuesA([])
      return
    }
    setWordValuesA(registerEntries.map((entry) => readWord(binaryBytesA, entry.offset, endianness)))
  }, [binaryBytesA, endianness, registerEntries])

  useEffect(() => {
    if (!binaryBytesB) {
      return
    }
    if (registerEntries.length === 0) {
      setWordValuesB([])
      return
    }
    setWordValuesB(registerEntries.map((entry) => readWord(binaryBytesB, entry.offset, endianness)))
  }, [binaryBytesB, endianness, registerEntries])

  const uploadBinary = async (target: 'A' | 'B') => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.bin,.blob'
    input.onchange = async () => {
      const selected = input.files?.[0]
      if (!selected) {
        return
      }
      const arrayBuffer = await selected.arrayBuffer()
      const bytes = new Uint8Array(arrayBuffer)
      const hash = await computeBlobHash(bytes)
      if (target === 'A') {
        setBinaryBytesA(bytes)
        setFileNameA(selected.name.replace(/(\.\w+)?$/, `_${blobTypeName}_edited.bin`))
        setFileHashA(hash)
      } else {
        setBinaryBytesB(bytes)
        setFileHashB(hash)
      }
      message.success(`Blob ${target} 已加载，大小 ${bytes.length} bytes，hash=${hash.slice(0, 12)}...`)
    }
    input.click()
  }

  const syncWordsFromBinaryA = () => {
    if (!binaryBytesA) {
      message.warning('请先加载 Blob A')
      return
    }
    setWordValuesA(registerEntries.map((entry) => readWord(binaryBytesA, entry.offset, endianness)))
    message.success('Blob A 已从原始文件重新读取')
  }

  const syncWordsFromBinaryB = () => {
    if (!binaryBytesB) {
      message.warning('请先加载 Blob B')
      return
    }
    setWordValuesB(registerEntries.map((entry) => readWord(binaryBytesB, entry.offset, endianness)))
    message.success('Blob B 已从原始文件重新读取')
  }

  const updateFieldValue = (registerIndex: number, field: FieldSpec, nextValue: number) => {
    setWordValuesA((prev) => {
      const cloned = [...prev]
      const currentWord = cloned[registerIndex] ?? 0
      cloned[registerIndex] = setFieldValue(currentWord, field, nextValue)
      return cloned
    })
  }

  const updateRegisterWordValue = (registerIndex: number, nextValue: number | string | null) => {
    setWordValuesA((prev) => {
      const cloned = [...prev]
      cloned[registerIndex] = toSafeUint(nextValue, 0xffffffff)
      return cloned
    })
  }

  const downloadBlob = () => {
    if (definitionsLoading || definitionsError) {
      message.warning('寄存器定义尚未就绪')
      return
    }
    if (registerEntries.length === 0) {
      message.warning('请先加载寄存器定义')
      return
    }
    const baseLength = binaryBytesA?.length ?? 0
    const totalLength = Math.max(baseLength, registerEntries.length * 4)
    const outBytes = new Uint8Array(totalLength)
    if (binaryBytesA) {
      outBytes.set(binaryBytesA)
    }
    registerEntries.forEach((entry, index) => {
      const word = wordValuesA[index] ?? 0
      writeWord(outBytes, entry.offset, word, endianness)
    })

    const blob = new Blob([outBytes], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileNameA
    a.click()
    URL.revokeObjectURL(url)
  }

  const changedRegisterCount = useMemo(() => {
    if (!binaryBytesB) {
      return 0
    }
    return registerEntries.reduce((count, _entry, index) => {
      const aWord = wordValuesA[index] ?? 0
      const bWord = wordValuesB[index] ?? 0
      return count + (aWord !== bWord ? 1 : 0)
    }, 0)
  }, [binaryBytesB, registerEntries, wordValuesA, wordValuesB])

  const buildShareUrl = () => {
    if (!binaryBytesA) {
      message.warning('请先加载 Blob A')
      return
    }
    const payload = {
      v: 1,
      t: blobTypeName,
      e: endianness,
      a: bytesToBase64Url(binaryBytesA),
      b: binaryBytesB ? bytesToBase64Url(binaryBytesB) : '',
      nA: fileNameA,
    }
    const encoded = encodeSharePayload(payload)
    const url = `${window.location.origin}${window.location.pathname}#s=${encoded}`
    setShareUrl(url)
    if (url.length > 7000) {
      message.warning('分享链接较长，部分聊天工具可能截断')
    } else {
      message.success('已生成分享链接')
    }
  }

  const copyShareUrl = async () => {
    if (!shareUrl) {
      message.warning('请先生成分享链接')
      return
    }
    try {
      await navigator.clipboard.writeText(shareUrl)
      message.success('分享链接已复制')
    } catch {
      message.error('复制失败，请手动复制输入框内容')
    }
  }

  return (
    <div className="app-shell">
      <Title level={2} style={{ marginTop: 0 }}>
        Blob Register Visual Editor
      </Title>
      <Text type="secondary">
        固定支持 dma / activation / ctrl / parameter 四种 blob，可视化按位编辑并导出写回
      </Text>

      <Divider />

      {definitionsError && (
        <Alert className="app-alert" type="error" showIcon title={definitionsError} />
      )}

      {definitionsLoading && (
        <div className="definitions-loading">
          <Spin description="正在加载寄存器定义…" />
        </div>
      )}

      <Card>
        <Flex wrap gap={12} align="center">
          <Select
            placeholder="选择 Blob 类型"
            style={{ minWidth: 220 }}
            value={blobTypeName}
            options={[
              { value: 'dma', label: 'dma' },
              { value: 'activation', label: 'activation' },
              { value: 'ctrl', label: 'ctrl' },
              { value: 'parameter', label: 'parameter' },
            ]}
            onChange={(value) => {
              const nextType = value as BlobTypeName
              setBlobTypeName(nextType)
              if (!binaryBytesA) {
                setWordValuesA([])
              }
            }}
            disabled={definitionsLoading || Boolean(definitionsError)}
          />
          <Button
            icon={<UploadOutlined />}
            disabled={definitionsLoading || Boolean(definitionsError) || registerEntries.length === 0}
            onClick={() => uploadBinary('A')}
          >
            加载 Blob A（可编辑）
          </Button>
          <Button
            icon={<UploadOutlined />}
            disabled={definitionsLoading || Boolean(definitionsError) || registerEntries.length === 0}
            onClick={() => uploadBinary('B')}
          >
            加载 Blob B（对比）
          </Button>
          <Select
            style={{ width: 160 }}
            value={endianness}
            options={[
              { value: 'little', label: 'Little Endian' },
              { value: 'big', label: 'Big Endian' },
            ]}
            onChange={(value) => setEndianness(value)}
            disabled={definitionsLoading || Boolean(definitionsError)}
          />
          <Button
            onClick={syncWordsFromBinaryA}
            disabled={definitionsLoading || Boolean(definitionsError) || !binaryBytesA || registerEntries.length === 0}
          >
            重载 Blob A
          </Button>
          <Button
            onClick={syncWordsFromBinaryB}
            disabled={definitionsLoading || Boolean(definitionsError) || !binaryBytesB || registerEntries.length === 0}
          >
            重载 Blob B
          </Button>
          <Button
            type="primary"
            onClick={downloadBlob}
            disabled={
              definitionsLoading ||
              Boolean(definitionsError) ||
              registerEntries.length === 0 ||
              wordValuesA.length === 0
            }
          >
            导出 Blob A
          </Button>
        </Flex>

        <div className="meta-row">
          <Tag color="green">类型: {blobTypeName}</Tag>
          <Tag color="blue">寄存器数量: {registerEntries.length}</Tag>
          <Tag color="purple">定义尺寸: {expectedSize} bytes</Tag>
          {binaryBytesA && <Tag color="gold">Blob A: {binaryBytesA.length} bytes</Tag>}
          {binaryBytesB && <Tag color="volcano">Blob B: {binaryBytesB.length} bytes</Tag>}
          {binaryBytesB && <Tag color="magenta">差异寄存器: {changedRegisterCount}</Tag>}
          {fileHashA && (
            <Tag color="gold">
              A-hash: {fileHashA.slice(0, 12)}
              ...
            </Tag>
          )}
          {fileHashB && (
            <Tag color="volcano">
              B-hash: {fileHashB.slice(0, 12)}
              ...
            </Tag>
          )}
        </div>
        <Flex className="share-row" wrap gap={8} align="center">
          <Button onClick={buildShareUrl} disabled={!binaryBytesA}>
            生成分享链接
          </Button>
          <Button onClick={copyShareUrl} disabled={!shareUrl}>
            复制链接
          </Button>
          {shareUrl && (
            <Text copyable={{ text: shareUrl }} className="share-url-text">
              {shareUrl}
            </Text>
          )}
        </Flex>
      </Card>

      {registerEntries.length > 0 && !binaryBytesA && (
        <Alert
          className="app-alert"
          title="请至少上传 Blob A（用于编辑和导出）。"
          type="info"
          showIcon
        />
      )}

      {registerEntries.length > 0 &&
        binaryBytesA &&
        binaryBytesA.length < expectedSize && (
          <Alert
            className="app-alert"
            type="warning"
            showIcon
            title={`Blob A 比定义短：文件 ${binaryBytesA.length} bytes，定义需要 ${expectedSize} bytes，缺失部分会按 0 补齐。`}
          />
        )}

      {registerEntries.length > 0 &&
        binaryBytesB &&
        binaryBytesB.length < expectedSize && (
          <Alert
            className="app-alert"
            type="warning"
            showIcon
            title={`Blob B 比定义短：文件 ${binaryBytesB.length} bytes，定义需要 ${expectedSize} bytes，缺失部分按 0 对比。`}
          />
        )}

      {registerEntries.length === 0 ? (
        <Card className="empty-card">
          <Alert type="warning" showIcon title={`当前类型 ${blobTypeName} 没有寄存器定义。`} />
        </Card>
      ) : (
        <Collapse
          className="register-list"
          items={registerEntries.map((entry, index) => {
            const wordA = wordValuesA[index] ?? 0
            const wordB = wordValuesB[index] ?? 0
            const registerDiff = binaryBytesB ? wordA !== wordB : false
            return {
              key: entry.key,
              label: (
                <div
                  className={
                    registerDiff
                      ? 'register-header-frame register-header-diff-frame'
                      : 'register-header-frame'
                  }
                >
                  <div className="register-header-content">
                    <Space size="middle" wrap className="register-header-main">
                      <Tag>{entry.groupName}</Tag>
                      <Text strong>{entry.registerName}</Text>
                      <Text type="secondary">idx={entry.registerIndex}</Text>
                      <Text type="secondary">offset=0x{entry.offset.toString(16)}</Text>
                      {registerDiff && <Tag color="red">DIFF</Tag>}
                    </Space>
                    <Space className="register-ab-values" size="small" wrap>
                      <Tag color="geekblue" className="register-ab-value-tag">
                        A: {formatHex32(wordA)}
                      </Tag>
                      {binaryBytesB && (
                        <Tag color="volcano" className="register-ab-value-tag">
                          B: {formatHex32(wordB)}
                        </Tag>
                      )}
                    </Space>
                  </div>
                </div>
              ),
              children: (
                <div>
                  {entry.fields.length === 0 ? (
                    <Card size="small" className={registerDiff ? 'field-diff-card' : undefined}>
                      <Flex justify="space-between" align="center" wrap gap={12}>
                        <Space>
                          <Text type="secondary">无位域定义，直接编辑 32-bit 原值</Text>
                          {registerDiff && <Tag color="red">DIFF</Tag>}
                        </Space>
                        <Space className="field-ab-values">
                          <Text type="secondary">A</Text>
                          <InputNumber
                            min={0}
                            max={0xffffffff}
                            value={wordA}
                            parser={(v) => parseMaybeHexInput(v)}
                            formatter={(v) => formatHex32(toSafeUint(v, 0xffffffff))}
                            onChange={(next) => updateRegisterWordValue(index, next)}
                          />
                          {binaryBytesB && (
                            <>
                              <Text type="secondary">B</Text>
                              <Tag color={registerDiff ? 'red' : 'default'}>{formatHex32(wordB)}</Tag>
                            </>
                          )}
                        </Space>
                      </Flex>
                    </Card>
                  ) : (
                    <Flex vertical gap={10}>
                      {entry.fields.map((field, fieldIndex) => {
                        const { start, end } = normalizeBits(field.bits)
                        const width = end - start + 1
                        const max = Number((1n << BigInt(width)) - 1n)
                        const fieldValueA = getFieldValue(wordA, field)
                        const fieldValueB = getFieldValue(wordB, field)
                        const fieldDiff = binaryBytesB ? fieldValueA !== fieldValueB : false
                        return (
                          <Card
                            key={`${entry.key}:${field.name}:${fieldIndex}`}
                            size="small"
                            className={fieldDiff ? 'field-diff-card' : undefined}
                          >
                            <Flex justify="space-between" align="center" wrap gap={12}>
                              <Space>
                                <Text strong>{field.name}</Text>
                                <Tag color="cyan">
                                  bits[{start}
                                  {start !== end ? `..${end}` : ''}]
                                </Tag>
                                <Text type="secondary">max={max}</Text>
                                {fieldDiff && <Tag color="red">DIFF</Tag>}
                              </Space>
                              <Space className="field-ab-values">
                                <Text type="secondary">A</Text>
                                <InputNumber
                                  min={0}
                                  max={max}
                                  value={fieldValueA}
                                  parser={(v) => parseMaybeHexInput(v)}
                                  onChange={(next) =>
                                    updateFieldValue(index, field, toSafeUint(next, max))
                                  }
                                />
                                {binaryBytesB && (
                                  <>
                                    <Text type="secondary">B</Text>
                                    <Tag color={fieldDiff ? 'red' : 'default'}>{fieldValueB}</Tag>
                                  </>
                                )}
                              </Space>
                            </Flex>
                          </Card>
                        )
                      })}
                    </Flex>
                  )}
                </div>
              ),
            }
          })}
        />
      )}
    </div>
  )
}

export default App
