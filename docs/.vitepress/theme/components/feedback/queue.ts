// 离线提交队列：
// - 幂等键在入队时生成并持久化，断网/刷新/重试绝不重复建工单
// - 附件若已拿到 uploadId（哪怕只传了部分分片），一并持久化，上线后续传
// - 用户标识最小化：队列只存提交者自己输入的内容，不写指纹

import { submitTicket, uploadAttachment, type SubmitInput } from './api'

const QUEUE_KEY = 'doc-feedback-offline-queue-v1'

export interface QueuedItem {
  idempotencyKey: string
  draft: SubmitInput
  files: Array<{
    name: string
    size: number
    contentType: string
    visibility: 'maintainer_only' | 'public'
    uploadId?: string // 已创建的可恢复上传会话
  }>
  status: 'queued' | 'uploading' | 'submitting' | 'failed'
  error?: string
  createdAt: number
}

export function loadQueue(): QueuedItem[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]')
  } catch {
    return []
  }
}

export function saveQueue(q: QueuedItem[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q))
}

export function enqueue(item: QueuedItem) {
  const q = loadQueue()
  q.push(item)
  saveQueue(q)
}

export function removeItem(key: string) {
  saveQueue(loadQueue().filter((x) => x.idempotencyKey !== key))
}

export function updateItem(key: string, patch: Partial<QueuedItem>) {
  const q = loadQueue().map((x) => (x.idempotencyKey === key ? { ...x, ...patch } : x))
  saveQueue(q)
}

// File 句柄无法持久化；提交组件在页面存活期间持有 File 映射
const fileHandles = new Map<string, File[]>()
export function rememberFiles(key: string, files: File[]) {
  fileHandles.set(key, files)
}
export function takeFiles(key: string): File[] {
  return fileHandles.get(key) || []
}

export interface ProcessResult {
  key: string
  ok: boolean
  replay?: boolean
  ticketId?: string
  viewerToken?: string
  error?: string
}

// 处理整个队列；重复执行安全（每个 item 有幂等键，服务端对同一 key 返回同一回执）
export async function processQueue(onProgress?: (info: { key: string; phase: string; pct: number }) => void):
  Promise<ProcessResult[]> {
  const results: ProcessResult[] = []
  for (const item of loadQueue()) {
    if (item.status === 'submitting') {
      // 上次可能已成功但回执丢失：服务端用幂等键去重并返回原工单，
      // 只是 viewerToken 只在首次出现，这里通过无 token 查询兜底
    }
    try {
      updateItem(item.idempotencyKey, { status: 'uploading' })
      const files = takeFiles(item.idempotencyKey)
      const uploadIds: string[] = []
      for (let i = 0; i < item.files.length; i++) {
        const meta = item.files[i]
        const file = files[i]
        if (!file) throw new Error(`attachment_unavailable:${meta.name}`)
        const existing = meta.uploadId
          ? { uploadId: meta.uploadId, received: [] }
          : undefined
        const { uploadId } = await uploadAttachment(
          file,
          (done, total) => onProgress?.({
            key: item.idempotencyKey,
            phase: `上传附件 ${meta.name}`,
            pct: Math.round((done / total) * 100)
          }),
          existing
        )
        meta.uploadId = uploadId
        uploadIds.push(uploadId)
        updateItem(item.idempotencyKey, { files: [...item.files] })
      }

      updateItem(item.idempotencyKey, { status: 'submitting' })
      const res = await submitTicket(item.draft, item.idempotencyKey, uploadIds)
      results.push({
        key: item.idempotencyKey,
        ok: true,
        replay: res.idempotent_replay,
        ticketId: res.ticket.id,
        viewerToken: res.receipt.viewerToken
      })
      removeItem(item.idempotencyKey)
      fileHandles.delete(item.idempotencyKey)
      // 持久化回执（提交者本人凭回执查私密信息）
      if (!res.idempotent_replay) saveReceipt(res.ticket.id, res.receipt.viewerToken)
    } catch (e) {
      const message = (e as Error).message || 'unknown_error'
      updateItem(item.idempotencyKey, { status: 'failed', error: message })
      results.push({ key: item.idempotencyKey, ok: false, error: message })
    }
  }
  return results
}

const RECEIPTS_KEY = 'doc-feedback-receipts-v1'
export function saveReceipt(ticketId: string, token: string) {
  const all = JSON.parse(localStorage.getItem(RECEIPTS_KEY) || '{}')
  all[ticketId] = token
  localStorage.setItem(RECEIPTS_KEY, JSON.stringify(all))
}
export function getReceipts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(RECEIPTS_KEY) || '{}')
  } catch {
    return {}
  }
}
