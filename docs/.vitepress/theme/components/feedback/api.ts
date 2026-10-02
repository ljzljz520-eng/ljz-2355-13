// 反馈工单前端 API：
// - 所有提交携带幂等键（离线时也提前生成），重复网络回执返回同一工单
// - 附件分片上传，中断后凭 uploadId 续传，不重传已完成分片
// - 对公开访客最小化披露：默认匿名，contact 可选，附件默认不公开

export interface FeedbackEnv {
  url?: string
  language?: string
  viewport?: string
  extra?: Record<string, unknown>
}

export interface SubmitInput {
  category: 'example_failure' | 'content_question' | 'other'
  title: string
  body: string
  contact?: string
  contactDisplay?: 'private' | 'public'
  pageVersion: string
  pagePath: string
  pageAnchor?: string | null
  headingSnapshot?: string | null
  affectedVersions?: string[]
  env?: FeedbackEnv
  attachments?: AttachmentFile[]
}

export interface AttachmentFile {
  file: File
  visibility: 'maintainer_only' | 'public'
}

export interface Receipt {
  ticketId: string
  viewerToken: string
}

function base(): string {
  // 构建期可通过 define 注入；默认同源 /api
  return ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_FEEDBACK_API || '/feedback-api')
}

async function http<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(base() + path, {
    ...opts,
    headers: { ...(opts.headers || {}) },
    credentials: 'omit'
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    ;(err as Error & { status: number }).status = res.status
    throw err
  }
  return data as T
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return 'fb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
}

// 收集当前页面的环境声明（接口原样保存，公开侧不回显完整指纹）
export function collectEnv(pageVersion: string) {
  return {
    url: typeof location !== 'undefined' ? location.pathname + location.hash : undefined,
    language: typeof navigator !== 'undefined' ? navigator.language : undefined,
    viewport: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : undefined,
    extra: {
      pageVersion,
      online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      timeZone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined
    }
  }
}

// 找当前锚点对应标题快照（删段/迁移后仍可辨认旧定位）
export function findAnchorContext(): { anchor: string | null; heading: string | null } {
  if (typeof location === 'undefined' || !location.hash) return { anchor: null, heading: null }
  const anchor = location.hash
  let heading: string | null = null
  try {
    const el = document.querySelector(decodeURIComponent(anchor))
    if (el) {
      const h = el.closest('h1,h2,h3,h4,h5,h6') || (el.tagName.match(/^H[1-6]$/) ? el : null)
      heading = (h?.textContent || '').trim().slice(0, 200) || null
    }
  } catch { /* ignore invalid selector */ }
  return { anchor, heading }
}

// ---- 可恢复上传：返回 uploadId 与完成状态；中断后调用 resumeUpload 续传 ----------
const CHUNK_SIZE = 256 * 1024

export async function uploadAttachment(
  file: File,
  onProgress?: (done: number, total: number) => void,
  existing?: { uploadId: string; received: number[] }
): Promise<{ uploadId: string }> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
  let uploadId = existing?.uploadId
  let received = new Set(existing?.received ?? [])

  if (!uploadId) {
    const created = await http<{ uploadId: string }>('/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        totalSize: file.size,
        chunkSize: CHUNK_SIZE,
        totalChunks
      })
    })
    uploadId = created.uploadId
  } else {
    // 恢复会话：向服务器查询已收分片，避免重传
    const st = await http<{ receivedChunks: number[] }>(`/uploads/${uploadId}`)
    received = new Set(st.receivedChunks)
  }

  for (let i = 0; i < totalChunks; i++) {
    if (received.has(i)) {
      onProgress?.(Math.min((i + 1) * CHUNK_SIZE, file.size), file.size)
      continue
    }
    const chunk = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size))
    const buf = await chunk.arrayBuffer()
    // 重复网络回执安全：分片在服务端幂等，重发同一 index 不会重复写入
    await http(`/uploads/${uploadId}/chunks/${i}?size=${buf.byteLength}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buf
    })
    onProgress?.(Math.min((i + 1) * CHUNK_SIZE, file.size), file.size)
  }

  await http(`/uploads/${uploadId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  })
  return { uploadId }
}

export async function resumeUpload(uploadId: string) {
  return http<{ uploadId: string; status: string; receivedChunks: number[] }>(`/uploads/${uploadId}`)
}

// ---- 提交工单（幂等） ----------------------------------------------------------
interface TicketResponse {
  idempotent_replay: boolean
  ticket: { id: string }
  receipt: Receipt
}

export async function submitTicket(input: SubmitInput, idempotencyKey: string, uploadIds: string[]):
  Promise<TicketResponse> {
  return http<TicketResponse>('/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...input,
      attachments: input.attachments?.map((a, i) => ({
        uploadId: uploadIds[i],
        // 默认最小披露：除非用户显式公开，否则仅维护者可见
        visibility: a.visibility
      })),
      uploadIds,
      idempotencyKey
    })
  })
}

export async function fetchReceipt(ticketId: string, token: string) {
  return http(`/tickets/${ticketId}?token=${encodeURIComponent(token)}`)
}

export async function publicSummaries() {
  return http<{ summaries: Array<{ docVersion: string; fixedVersion: string; summary: string }> }>(
    '/public/revision-summary')
}
