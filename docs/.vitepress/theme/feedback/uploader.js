// 分片 + 断点续传：
//  - 文件按 512KB 切片，逐片 PUT（带片 sha256）
//  - 上传状态以 (upload_id) 持久化到 localStorage；中断/刷新后先查缺片再续传
//  - 完成时整文件 sha256 校验 + 服务端去重
const CHUNK_SIZE = 512 * 1024
const STORE_KEY = 'fb.uploads.v1'

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } catch { return {} }
}
function writeStore(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)) } catch {}
}

export async function sha256Hex(buf) {
  const h = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function chunkFile(file) {
  const chunks = []
  for (let i = 0; i < file.size; i += CHUNK_SIZE) {
    chunks.push(file.slice(i, Math.min(i + CHUNK_SIZE, file.size)))
  }
  return chunks
}

// 用文件名+大小+内容首片哈希作为恢复键：刷新后可找到未完成 upload_id
async function resumeKey(file, firstHash) {
  return await sha256Hex(new TextEncoder().encode(`${file.name}:${file.size}:${firstHash}`))
}

export async function uploadFile(file, opts = {}) {
  const { reporterToken, onProgress, signal } = opts
  const blobs = chunkFile(file)
  const firstHash = await sha256Hex(await blobs[0].arrayBuffer())
  const rKey = await resumeKey(file, firstHash)

  const store = readStore()
  let uploadId = store[rKey]?.uploadId
  let received = []

  if (uploadId) {
    // 恢复：查已上传分片
    try {
      const st = await fetch(
        `/api/feedback/uploads/${uploadId}/status?reporter_token=${encodeURIComponent(reporterToken)}`
      ).then((r) => r.json())
      if (st && Array.isArray(st.received_chunks)) received = st.received_chunks
    } catch { /* 服务端可能已清空，重新 init */ }
  }

  if (!uploadId || !received.length && uploadId) {
    // 新上传
    const init = await fetch('/api/feedback/uploads/init', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        size: file.size,
        mime: file.type || 'application/octet-stream',
        total_chunks: blobs.length,
        chunk_size: CHUNK_SIZE,
        reporter_token: reporterToken
      })
    }).then((r) => r.json())
    if (init.error) throw new Error(init.error)
    uploadId = init.upload_id
    received = init.received_chunks || []
  }

  store[rKey] = { uploadId, name: file.name, size: file.size, savedAt: Date.now() }
  writeStore(store)

  let doneBytes = received.length * Math.min(CHUNK_SIZE, file.size)
  for (let i = 0; i < blobs.length; i++) {
    if (received.includes(i)) continue
    signal?.throwIfAborted()
    const buf = await blobs[i].arrayBuffer()
    const cs = await sha256Hex(buf)
    const res = await fetch(
      `/api/feedback/uploads/${uploadId}/chunks/${i}?sha256=${cs}&reporter_token=${encodeURIComponent(reporterToken)}`,
      { method: 'PUT', body: buf, signal }
    )
    if (res.status === 422) throw new Error('分片校验失败')
    if (!res.ok) {
      // 中断：保留现场，下次可从 status 恢复
      throw Object.assign(new Error(`chunk ${i} 上传失败 (${res.status})`), { resumable: true, uploadId, index: i })
    }
    doneBytes += buf.byteLength
    onProgress?.(Math.round((doneBytes / file.size) * 100))
  }

  // 全部分片到位，请求合并；complete 接口本身幂等
  const wholeHash = await digestWholeFile(file, signal)
  const res = await fetch(`/api/feedback/uploads/${uploadId}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reporter_token: reporterToken, sha256: wholeHash })
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error)
  delete store[rKey]
  writeStore(store)
  return data // { sha256, attachment_id, filename, size }
}

async function digestWholeFile(file, signal) {
  // 使用 WebCrypto 流式（浏览器支持）；Node 测试走分块聚合
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    // 大文件整读可接受（默认上限 20MB）
    const buf = await file.arrayBuffer()
    signal?.throwIfAborted()
    return sha256Hex(buf)
  }
  throw new Error('crypto.subtle unavailable')
}

export function listResumable() {
  return Object.entries(readStore()).map(([key, v]) => ({ key, ...v }))
}
