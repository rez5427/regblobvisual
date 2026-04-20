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

function flattenRegisters(groupSpec: GroupSpec): RegisterEntry[] {
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
        offset: registerIndex * 4,
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

function App() {
  const [blobTypeName, setBlobTypeName] = useState<BlobTypeName>('dma')
  const [endianness, setEndianness] = useState<Endianness>('little')
  const [binaryBytes, setBinaryBytes] = useState<Uint8Array>()
  const [wordValues, setWordValues] = useState<number[]>([])
  const [fileName, setFileName] = useState<string>('edited_blob.bin')
  const [blobTypes, setBlobTypes] = useState<BlobTypeMap>({
    dma: {},
    activation: {},
    ctrl: {},
    parameter: {},
  })
  const [definitionsLoading, setDefinitionsLoading] = useState(true)
  const [definitionsError, setDefinitionsError] = useState<string>()

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setDefinitionsLoading(true)
      setDefinitionsError(undefined)
      try {
        const next = await loadBlobTypeDefinitions()
        if (!cancelled) {
          setBlobTypes(next)
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

  const currentGroupSpec = useMemo(() => {
    return blobTypes[blobTypeName]
  }, [blobTypeName, blobTypes])

  const registerEntries = useMemo(
    () => flattenRegisters(currentGroupSpec),
    [currentGroupSpec],
  )

  const expectedSize = registerEntries.length * 4

  useEffect(() => {
    if (!binaryBytes) {
      return
    }
    if (registerEntries.length === 0) {
      setWordValues([])
      return
    }
    setWordValues(registerEntries.map((entry) => readWord(binaryBytes, entry.offset, endianness)))
  }, [binaryBytes, endianness, registerEntries])

  const uploadBinary = async () => {
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
      setBinaryBytes(bytes)
      setFileName(selected.name.replace(/(\.\w+)?$/, `_${blobTypeName}_edited.bin`))
      message.success(`二进制已加载，大小 ${bytes.length} bytes`)
    }
    input.click()
  }

  const syncWordsFromBinary = () => {
    if (!binaryBytes) {
      message.warning('请先加载二进制 blob')
      return
    }
    setWordValues(registerEntries.map((entry) => readWord(binaryBytes, entry.offset, endianness)))
    message.success('已从原始 blob 重新读取')
  }

  const updateFieldValue = (registerIndex: number, field: FieldSpec, nextValue: number) => {
    setWordValues((prev) => {
      const cloned = [...prev]
      const currentWord = cloned[registerIndex] ?? 0
      cloned[registerIndex] = setFieldValue(currentWord, field, nextValue)
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
    const baseLength = binaryBytes?.length ?? 0
    const totalLength = Math.max(baseLength, registerEntries.length * 4)
    const outBytes = new Uint8Array(totalLength)
    if (binaryBytes) {
      outBytes.set(binaryBytes)
    }
    registerEntries.forEach((entry, index) => {
      const word = wordValues[index] ?? 0
      writeWord(outBytes, entry.offset, word, endianness)
    })

    const blob = new Blob([outBytes], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
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
              if (!binaryBytes) {
                setWordValues([])
              }
            }}
            disabled={definitionsLoading || Boolean(definitionsError)}
          />
          <Button
            icon={<UploadOutlined />}
            disabled={definitionsLoading || Boolean(definitionsError) || registerEntries.length === 0}
            onClick={uploadBinary}
          >
            加载二进制 Blob
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
            onClick={syncWordsFromBinary}
            disabled={definitionsLoading || Boolean(definitionsError) || !binaryBytes || registerEntries.length === 0}
          >
            从原始文件重载
          </Button>
          <Button
            type="primary"
            onClick={downloadBlob}
            disabled={
              definitionsLoading ||
              Boolean(definitionsError) ||
              registerEntries.length === 0 ||
              wordValues.length === 0
            }
          >
            导出写回 Blob
          </Button>
        </Flex>

        <div className="meta-row">
          <Tag color="green">类型: {blobTypeName}</Tag>
          <Tag color="blue">寄存器数量: {registerEntries.length}</Tag>
          <Tag color="purple">定义尺寸: {expectedSize} bytes</Tag>
          {binaryBytes && <Tag color="gold">文件尺寸: {binaryBytes.length} bytes</Tag>}
        </div>
      </Card>

      {registerEntries.length > 0 && !binaryBytes && (
        <Alert
          className="app-alert"
          title="请上传二进制 blob。"
          type="info"
          showIcon
        />
      )}

      {registerEntries.length > 0 &&
        binaryBytes &&
        binaryBytes.length < expectedSize && (
          <Alert
            className="app-alert"
            type="warning"
            showIcon
            title={`二进制比定义短：文件 ${binaryBytes.length} bytes，定义需要 ${expectedSize} bytes，缺失部分会按 0 补齐。`}
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
            const word = wordValues[index] ?? 0
            return {
              key: entry.key,
              label: (
                <Space size="middle" wrap>
                  <Tag>{entry.groupName}</Tag>
                  <Text strong>{entry.registerName}</Text>
                  <Text type="secondary">idx={entry.registerIndex}</Text>
                  <Text type="secondary">offset=0x{entry.offset.toString(16)}</Text>
                  <Tag color="geekblue">{formatHex32(word)}</Tag>
                </Space>
              ),
              children: (
                <div>
                  {entry.fields.length === 0 ? (
                    <Text type="secondary">
                      这个寄存器目前没有定义位域，保持 32-bit 原值展示。
                    </Text>
                  ) : (
                    <Flex vertical gap={10}>
                      {entry.fields.map((field, fieldIndex) => {
                        const { start, end } = normalizeBits(field.bits)
                        const width = end - start + 1
                        const max = Number((1n << BigInt(width)) - 1n)
                        return (
                          <Card key={`${entry.key}:${field.name}:${fieldIndex}`} size="small">
                            <Flex justify="space-between" align="center" wrap gap={12}>
                              <Space>
                                <Text strong>{field.name}</Text>
                                <Tag color="cyan">
                                  bits[{start}
                                  {start !== end ? `..${end}` : ''}]
                                </Tag>
                                <Text type="secondary">max={max}</Text>
                              </Space>
                              <InputNumber
                                min={0}
                                max={max}
                                value={getFieldValue(word, field)}
                                onChange={(next) => updateFieldValue(index, field, Number(next ?? 0))}
                              />
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
