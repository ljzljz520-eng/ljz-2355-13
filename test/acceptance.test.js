/**
 * 反馈工单系统 —— 验收测试
 * 覆盖：
 *  1. 重复网络回执（幂等键）
 *  2. 两个维护者合并同一工单
 *  3. 旧版本仍有问题（逐版本复开，不能并为一条已解决）
 *  4. 文档删段 + 页面迁移人工确认
 *  5. 附件上传中断/续传 + 公开访客权限
 *  6. 公开修订摘要只取已核实事实，未发布修复不显示为已上线
 *  另含：直接改状态 vs 证据推导、离线队列幂等
 */
import test, { after as testAfter } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(__dirname, '..', 'server', 'data', 'test-'))
const PORT = 8791
const BASE = `http://127.0.0.1:${PORT}`
const ALICE = 'tok_alice_demo'
const BOB = 'tok_bob_demo'

let server
test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      FEEDBACK_DB: path.join(TMP, 'test.db'),
      MAINTAINER_TOKEN_ALICE: ALICE,
      MAINTAINER_TOKEN_BOB: BOB
    }
  })
  let out = ''
  server.stdout.on('data', (d) => {
    out += d
    if (out.includes('listening')) return
  })
  server.stderr.pipe(process.stderr)
  // wait for health
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  const h = await fetch(`${BASE}/api/health`)
  assert.equal(h.ok, true)
})

testAfter(() => {
  server?.kill()
  fs.rmSync(TMP, { recursive: true, force: true })
})

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: {
      ...(opts.body && !opts.raw ? { 'content-type': 'application/json' } : {}),
      ...opts.headers
    },
    body: opts.raw ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}
const pub = (p, opts) => api(p, opts)
const mtn = (token, p, opts = {}) =>
  api(p, { ...opts, headers: { ...(opts.headers || {}), authorization: `Bearer ${token}` } })

const ticketPayload = (over = {}) => ({
  kind: 'example_failure',
  title: 'Button basic 示例点击报错',
  body: '点击 primary 按钮后控制台抛 TypeError，示例渲染中断',
  page_path: '/components/button',
  anchor: 'basic-usage',
  docs_version: '1.1.0',
  affected_versions: ['1.0.0', '1.1.0'],
  reporter_token: 'rt_reporter_A',
  contact: 'reader@example.com',
  env: { user_agent: 'Mozilla/5.0 Chrome/120', viewport: '1440x900', language: 'zh-CN', timezone: 'Asia/Shanghai' },
  ...over
})

// ---------------------------------------------------------------------------
test('1. 重复网络回执：同一幂等键多次提交只产生一条工单', async () => {
  const body = ticketPayload({ idempotency_key: 'idem-case-1' })
  const r1 = await pub('/api/feedback/tickets', { method: 'POST', body })
  const r2 = await pub('/api/feedback/tickets', { method: 'POST', body })
  const r3 = await pub('/api/feedback/tickets', { method: 'POST', body })
  assert.equal(r1.status, 201)
  assert.ok([200, 201].includes(r2.status))
  assert.equal(r3.data.code, r1.data.code)
  assert.equal(r3.data.reused, true)

  const list = await mtn(ALICE, '/api/maintainer/tickets')
  const codes = list.data.map((t) => t.code)
  assert.equal(codes.filter((c) => c === r1.data.code).length, 1)
})

test('1b. 页面版/锚点/环境声明被快照保存，联系方式仅维护者可见', async () => {
  const { code } = (await pub('/api/feedback/tickets', {
    method: 'POST',
    body: ticketPayload({ idempotency_key: 'idem-env', reporter_token: 'rt_reporter_ENV', anchor: 'env-anchor' })
  })).data
  const pubView = (await pub(`/api/feedback/tickets/${code}`)).data
  assert.equal(pubView.location.original_anchor, 'env-anchor')
  assert.equal(pubView.docs_version, '1.1.0')
  assert.equal('contact_masked' in pubView, false, '公开视图不含联系方式')
  assert.equal('env_snapshot' in pubView, false, '公开视图不回显完整环境快照')

  const mView = (await mtn(ALICE, `/api/maintainer/tickets/${code}`)).data
  assert.equal(mView.contact_masked, 're***@example.com')
  assert.match(mView.env_snapshot.user_agent, /Chrome/)
  assert.equal(mView.page_snapshot.anchor, 'env-anchor')
})

test('2. 两个维护者合并同一对工单：只产生一条关系，来源不丢失', async () => {
  const a = (await pub('/api/feedback/tickets', {
    method: 'POST', body: ticketPayload({ idempotency_key: 'dup-a', title: '重复反馈 A', reporter_token: 'rt_a' })
  })).data
  const b = (await pub('/api/feedback/tickets', {
    method: 'POST', body: ticketPayload({ idempotency_key: 'dup-b', title: '重复反馈 B', reporter_token: 'rt_b' })
  })).data
  // alice 与 bob 同时（顺序发出）合并 a -> b，且故意带同一幂等键
  const [rA, rB] = await Promise.all([
    mtn(ALICE, '/api/maintainer/merge', { method: 'POST', body: { source: a.code, target: b.code, idempotency_key: 'same-merge-key' } }),
    mtn(BOB, '/api/maintainer/merge', { method: 'POST', body: { source: a.code, target: b.code, idempotency_key: 'same-merge-key' } })
  ])
  assert.ok(rA.data.merged)
  assert.equal(rB.data.merged, true)
  // 再来一次幂等
  const rC = await mtn(ALICE, '/api/maintainer/merge', { method: 'POST', body: { source: a.code, target: b.code } })
  assert.equal(rC.data.reused, true)
  // 反向合并会形成环 -> 拒绝（不静默翻转、不丢关系）
  const rRev = await mtn(BOB, '/api/maintainer/merge', { method: 'POST', body: { source: b.code, target: a.code } })
  assert.equal(rRev.status, 400)
  // 来源工单仍然可访问，事件保留，并指向主工单
  const view = (await pub(`/api/feedback/tickets/${a.code}`)).data
  assert.equal(view.code, b.code, '查看被合并工单时落到主工单')
  assert.deepEqual(view.merged_from_chain, [a.code], '合并链保留来源工单号')
  const srcEvents = (await mtn(ALICE, `/api/maintainer/tickets/${a.code}`)).data
  assert.ok(srcEvents.events.some((e) => e.type === 'merged'))
})

test('3. 一问题多版本：修复需指明新版本+证据；旧版本仍有问题按版本复开', async () => {
  const t = (await pub('/api/feedback/tickets', {
    method: 'POST', body: ticketPayload({ idempotency_key: 'multi-ver' })
  })).data
  // 无证据直接标 verified -> 拒绝
  const noEvidence = await mtn(ALICE, `/api/maintainer/tickets/${t.code}/fix-verified`, {
    method: 'POST', body: { versions: ['1.0.0', '1.1.0'], fix_version: '1.2.0', evidence: '' }
  })
  assert.equal(noEvidence.status, 400)
  // 先提出修复：此时仍是 fix_in_review，不算已解决
  const proposed = await mtn(ALICE, `/api/maintainer/tickets/${t.code}/fix-proposed`, {
    method: 'POST', body: { versions: ['1.0.0', '1.1.0'], fix_version: '1.2.0', note: 'MR!421' }
  })
  assert.equal(proposed.data.effective_status, 'fix_in_review')
  // 验证有效：明确指出在新版本 1.2.0 验证 + 证据
  const verified = await mtn(BOB, `/api/maintainer/tickets/${t.code}/fix-verified`, {
    method: 'POST',
    body: {
      versions: ['1.0.0', '1.1.0'],
      fix_version: '1.2.0',
      evidence: 'MR!421 已合并，1.2.0 预览站点击 primary 无报错，验证人 bob'
    }
  })
  assert.equal(verified.data.effective_status, 'resolved')
  assert.equal(verified.data.fix_version_released, false, '1.2.0 尚未发布')

  // 旧版本 1.0.0 仍有问题：按版本复开，1.1.0 保持已解决
  const reopened = await mtn(ALICE, `/api/maintainer/tickets/${t.code}/reopen`, {
    method: 'POST', body: { versions: ['1.0.0'], reason: '1.0.x 分支未回合补丁，客户仍复现' }
  })
  assert.deepEqual(reopened.data.reopened_versions, ['1.0.0'])
  assert.deepEqual(reopened.data.still_resolved_versions, ['1.1.0'])
  assert.equal(reopened.data.effective_status, 'partially_resolved', '不能简单合并为一条已解决')

  const view = (await pub(`/api/feedback/tickets/${t.code}`)).data
  const v10 = view.affected_versions.find((x) => x.version === '1.0.0')
  const v11 = view.affected_versions.find((x) => x.version === '1.1.0')
  assert.equal(v10.state, 'open')
  assert.equal(v10.fix_version, null)
  assert.equal(v11.state, 'resolved')
  assert.equal(v11.fix_version, '1.2.0')
})

test('3b. 直接改状态不会改变证据推导出的有效状态，且公开视图不可见', async () => {
  const t = (await pub('/api/feedback/tickets', {
    method: 'POST', body: ticketPayload({ idempotency_key: 'override-1', reporter_token: 'rt_ov' })
  })).data
  const r = await mtn(ALICE, `/api/maintainer/tickets/${t.code}/status`, {
    method: 'POST', body: { status: 'resolved', reason: '先关掉，以后再说' }
  })
  assert.equal(r.data.effective_status, 'open', '证据缺失，有效状态仍为 open')
  assert.equal(r.data.status_override, 'resolved')
  const pubView = (await pub(`/api/feedback/tickets/${t.code}`)).data
  assert.equal(pubView.effective_status, 'open')
  assert.equal(pubView.events.some((e) => e.type === 'status_override'), false, '覆盖事件不对公开访客披露')
})

test('4a. 页面迁移：旧反馈保留原定位；未确认不公开，确认后才建立到新位置的关系', async () => {
  const t = (await pub('/api/feedback/tickets', {
    method: 'POST',
    body: ticketPayload({
      idempotency_key: 'mig-1', reporter_token: 'rt_mig',
      page_path: '/guide/old-page', anchor: 'old-section', title: '旧页面反馈'
    })
  })).data
  const proposal = await mtn(ALICE, '/api/maintainer/pages/migrate', {
    method: 'POST',
    body: { from_path: '/guide/old-page', from_anchor: 'old-section', to_path: '/guide/new-page', to_anchor: 'new-section', reason: '章节重构' }
  })
  assert.equal(proposal.data.confirmed, false)
  // 提交快照不动；公开视图尚看不到新位置
  let v = (await pub(`/api/feedback/tickets/${t.code}`)).data
  assert.equal(v.location.original_path, '/guide/old-page')
  assert.equal(v.location.confirmed_new_location, undefined)
  const lookupPending = (await pub('/api/feedback/lookup?path=/guide/old-page&anchor=old-section')).data
  assert.equal(lookupPending.confirmed_new_location, undefined)
  // bob 人工确认
  const confirmed = (await mtn(BOB, `/api/maintainer/pages/migrate/${proposal.data.migration_id}/confirm`, { method: 'POST', body: {} })).data
  assert.equal(confirmed.confirmed, true)
  assert.equal(confirmed.by, 'bob')
  v = (await pub(`/api/feedback/tickets/${t.code}`)).data
  assert.equal(v.location.original_path, '/guide/old-page', '原定位永久保留')
  assert.equal(v.location.confirmed_new_location.path, '/guide/new-page')
  assert.equal(v.location.confirmed_new_location.anchor, 'new-section')
})

test('4b. 文档删段：工单保留，标记段已删，公开可见标记但不丢原定位', async () => {
  const t = (await pub('/api/feedback/tickets', {
    method: 'POST',
    body: ticketPayload({ idempotency_key: 'del-sec-1', reporter_token: 'rt_del', anchor: 'gone-section' })
  })).data
  const r = await mtn(ALICE, '/api/maintainer/pages/section-deleted', {
    method: 'POST',
    body: {
      page_path: '/components/button', anchor: 'gone-section',
      deleted_text: '### 废弃的 size=mini 说明', reason: '该 API 已移除'
    }
  })
  assert.equal(r.status, 200)
  assert.ok(r.data.retained_tickets.includes(t.code))
  const v = (await pub(`/api/feedback/tickets/${t.code}`)).data
  assert.equal(v.location.section_status, 'deleted')
  assert.equal(v.location.section_deleted, true)
  assert.equal(v.location.original_anchor, 'gone-section')
})

test('5. 附件上传中断后续传；公开访客无权下载，提交者凭查询码可下载', async () => {
  const token = 'rt_with_attachment'
  const file = Buffer.alloc(1200 * 1024) // 1.2MB -> 3 片 (512KB)
  crypto.randomFillSync(file)
  const CHUNK = 512 * 1024
  const total = Math.ceil(file.length / CHUNK)
  const init = (await pub('/api/feedback/uploads/init', {
    method: 'POST',
    body: { filename: 'error-screen.bin', size: file.length, mime: 'application/octet-stream', total_chunks: total, chunk_size: CHUNK, reporter_token: token }
  })).data
  // 只传第 0、2 片 —— 模拟中途断在第 1 片
  for (const i of [0, 2]) {
    const buf = file.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, file.length))
    const r = await fetch(
      `${BASE}/api/feedback/uploads/${init.upload_id}/chunks/${i}?sha256=${crypto.createHash('sha256').update(buf).digest('hex')}&reporter_token=${token}`,
      { method: 'PUT', body: buf }
    )
    assert.equal(r.status, 200)
  }
  // 此时 complete 应报缺片
  const incomplete = await pub(`/api/feedback/uploads/${init.upload_id}/complete`, {
    method: 'POST', body: { reporter_token: token }
  })
  assert.equal(incomplete.data.done, false)
  assert.deepEqual(incomplete.data.missing_chunks, [1])
  // 恢复：status 显示缺第 1 片
  const st = (await pub(`/api/feedback/uploads/${init.upload_id}/status?reporter_token=${token}`)).data
  assert.deepEqual(st.missing_chunks, [1])
  // 续传第 1 片
  const buf1 = file.subarray(CHUNK, 2 * CHUNK)
  const put1 = await fetch(
    `${BASE}/api/feedback/uploads/${init.upload_id}/chunks/1?sha256=${crypto.createHash('sha256').update(buf1).digest('hex')}&reporter_token=${token}`,
    { method: 'PUT', body: buf1 }
  )
  assert.equal(put1.status, 200)
  // 错误的整文件 hash -> 拒绝
  const bad = await pub(`/api/feedback/uploads/${init.upload_id}/complete`, {
    method: 'POST', body: { reporter_token: token, sha256: 'deadbeef' }
  })
  assert.equal(bad.status, 422)
  // 正确 hash 完成；重复 complete 幂等
  const digest = crypto.createHash('sha256').update(file).digest('hex')
  const done1 = (await pub(`/api/feedback/uploads/${init.upload_id}/complete`, {
    method: 'POST', body: { reporter_token: token, sha256: digest }
  })).data
  const done2 = (await pub(`/api/feedback/uploads/${init.upload_id}/complete`, {
    method: 'POST', body: { reporter_token: token, sha256: digest }
  })).data
  assert.equal(done1.sha256, digest)
  assert.equal(done2.reused, true)

  // 用该附件提交工单
  const tk = (await pub('/api/feedback/tickets', {
    method: 'POST',
    body: ticketPayload({
      idempotency_key: 'att-ticket', reporter_token: token,
      title: '带截图的报错', attachments: [digest]
    })
  })).data
  const view = (await pub(`/api/feedback/tickets/${tk.code}`)).data
  assert.equal(view.attachments.length, 1)
  assert.equal(view.attachments[0].downloadable, false, '公开访客不可下载')

  // 无凭证下载 -> 403（即使知道 attachment id）
  const noAuth = await fetch(`${BASE}/api/feedback/attachments/${done1.attachment_id}/download`)
  assert.equal(noAuth.status, 403)
  // 别的访客 token -> 403
  const other = await fetch(
    `${BASE}/api/feedback/attachments/${done1.attachment_id}/download?token=${'rt_stranger'}`
  )
  assert.equal(other.status, 403)
  // 提交者本人 -> 200 且内容一致
  const own = await fetch(
    `${BASE}/api/feedback/attachments/${done1.attachment_id}/download?ticket=${tk.code}&token=${token}`
  )
  assert.equal(own.status, 200)
  const got = Buffer.from(await own.arrayBuffer())
  assert.equal(crypto.createHash('sha256').update(got).digest('hex'), digest)
  // 维护者 -> 200
  const mt = await fetch(`${BASE}/api/feedback/attachments/${done1.attachment_id}/download`, {
    headers: { authorization: `Bearer ${ALICE}` }
  })
  assert.equal(mt.status, 200)

  // 别人不能把该附件绑到自己的工单
  const steal = await pub('/api/feedback/tickets', {
    method: 'POST',
    body: ticketPayload({ idempotency_key: 'steal-att', reporter_token: 'rt_thief', attachments: [digest] })
  })
  assert.equal(steal.status, 403)
})

test('6. 公开修订摘要：只取已核实且已发布的修复；未发布不显示为已上线', async () => {
  // 工单 X：1.0.0 问题，已在 1.1.0（已发布）验证 -> 应出现
  const x = (await pub('/api/feedback/tickets', {
    method: 'POST',
    body: {
      ...ticketPayload(),
      idempotency_key: 'cl-x', reporter_token: 'rt_clx',
      title: '已上线修复', affected_versions: ['1.0.0'], docs_version: '1.0.0',
      page_path: '/guide/quickstart', anchor: 'install-issue'
    }
  })).data
  await mtn(ALICE, `/api/maintainer/tickets/${x.code}/fix-verified`, {
    method: 'POST',
    body: { versions: ['1.0.0'], fix_version: '1.1.0', evidence: '1.1.0 文档已更正安装命令并在生产站验证' }
  })

  // 工单 Y：在未发布的 1.2.0 验证 -> 不应出现
  const y = (await pub('/api/feedback/tickets', {
    method: 'POST',
    body: {
      ...ticketPayload(),
      idempotency_key: 'cl-y', reporter_token: 'rt_cly',
      title: '未发布修复', affected_versions: ['1.1.0'], docs_version: '1.1.0',
      page_path: '/guide/installation', anchor: 'peer-dep'
    }
  })).data
  await mtn(ALICE, `/api/maintainer/tickets/${y.code}/fix-verified`, {
    method: 'POST',
    body: { versions: ['1.1.0'], fix_version: '1.2.0', evidence: '1.2.0 预览站验证通过，等待发版' }
  })

  // 工单 Z：仅 fix_proposed（无验证证据）-> 不应出现
  const z = (await pub('/api/feedback/tickets', {
    method: 'POST',
    body: {
      ...ticketPayload(),
      idempotency_key: 'cl-z', reporter_token: 'rt_clz',
      title: '仅提出修复未验证', affected_versions: ['1.0.0'], docs_version: '1.0.0'
    }
  })).data
  await mtn(ALICE, `/api/maintainer/tickets/${z.code}/fix-proposed`, {
    method: 'POST', body: { versions: ['1.0.0'], fix_version: '1.1.0' }
  })

  const log = (await pub('/api/feedback/changelog')).data
  const all = Object.values(log.versions).flat()
  const codes = all.map((e) => e.ticket)
  assert.ok(codes.includes(x.code), '已发布已核实修复应出现')
  assert.equal(codes.includes(y.code), false, '未发布版本的修复不得显示为已上线')
  assert.equal(codes.includes(z.code), false, '缺少验证证据的修复不出现')
  assert.ok(all.find((e) => e.ticket === x.code).fixed_in === '1.1.0')

  // 发布 1.2.0 后，Y 才出现
  await mtn(BOB, '/api/maintainer/releases', { method: 'POST', body: { version: '1.2.0', released: true } })
  const log2 = (await pub('/api/feedback/changelog')).data
  const codes2 = Object.values(log2.versions).flat().map((e) => e.ticket)
  assert.ok(codes2.includes(y.code), '版本发布后修复才进入公开摘要')
  assert.equal(codes2.includes(z.code), false)

  // 维护者鉴权：无 token / 坏 token 被拒
  assert.equal((await api('/api/maintainer/tickets')).status, 401)
  assert.equal((await api('/api/maintainer/tickets', { headers: { authorization: 'Bearer nope' } })).status, 403)
})
