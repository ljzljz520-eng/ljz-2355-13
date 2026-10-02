import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, api, MONA, RAFA, ADMIN, ticketPayload } from './helpers.js'

let env
before(async () => { env = await startTestServer() })
after(async () => { await env.stop() })

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

describe('访客提交与隐私最小披露', () => {
  test('接口保存页面版、锚点、标题快照与环境声明', async () => {
    const payload = ticketPayload({ contact: 'user@example.com' })
    const r = await api(env.base, '/api/tickets', { method: 'POST', body: payload })
    assert.equal(r.status, 200)
    assert.match(r.json.ticket.id, /^TKT-\d{6}$/)
    assert.ok(r.json.receipt.viewerToken, '首次返回查看令牌')
    const t = r.json.ticket
    assert.equal(t.page.version, '2026.09.0')
    assert.equal(t.page.path, '/components/button')
    assert.equal(t.page.anchor, '#basic-usage')
    assert.equal(t.page.headingSnapshot, '基础按钮用法')
    // 公开视图不披露联系方式与完整环境指纹
    assert.equal(t.contact, undefined)
    assert.equal(t.environment.url, undefined)
  })

  test('公开查询不泄露 contact / UA；凭回执令牌可私密查看', async () => {
    const payload = ticketPayload({ idempotencyKey: crypto.randomUUID(), contact: 'secret@x.com' })
    const created = await api(env.base, '/api/tickets', { method: 'POST', body: payload })
    const id = created.json.ticket.id
    const token = created.json.receipt.viewerToken

    const pub = await api(env.base, `/api/tickets/${id}`)
    assert.equal(pub.status, 200)
    assert.equal(pub.json.contact, undefined)
    assert.equal(pub.json.environment.userAgent, undefined)

    const mine = await api(env.base, `/api/tickets/${id}?token=${encodeURIComponent(token)}`)
    assert.equal(mine.json.contact, 'secret@x.com')

    const bad = await api(env.base, `/api/tickets/${id}?token=wrong`)
    assert.equal(bad.status, 404)
  })
})

describe('验收①：重复网络回执幂等', () => {
  test('同一幂等键重复提交返回同一张工单', async () => {
    const payload = ticketPayload({ title: '幂等专用单-不重复' }) // 固定 UUID
    const r1 = await api(env.base, '/api/tickets', { method: 'POST', body: payload })
    const r2 = await api(env.base, '/api/tickets', { method: 'POST', body: payload })
    const r3 = await api(env.base, '/api/tickets', { method: 'POST', body: payload })
    assert.equal(r1.status, 200)
    assert.equal(r1.json.idempotent_replay, false)
    assert.equal(r2.json.idempotent_replay, true)
    assert.equal(r3.json.idempotent_replay, true)
    assert.equal(r1.json.ticket.id, r2.json.ticket.id)
    assert.equal(r2.json.ticket.id, r3.json.ticket.id)
    // 仅首次返回查看令牌，重复回执不再下发
    assert.equal(r2.json.receipt.viewerToken, null)
    const list = await api(env.base, '/api/maintainer/tickets', { headers: { Authorization: MONA } })
    const same = list.json.tickets.filter((t) =>
      t.title === payload.title && t.page.version === payload.pageVersion &&
      t.page.anchor === payload.pageAnchor)
    assert.equal(same.length, 1, '不得产生重复工单')
  })
})

describe('多版本：不能简单合并为一条已解决；修复须指出验证新版本', () => {
  let id, token
  test('同一问题关联多个受影响版', async () => {
    const created = await api(env.base, '/api/tickets', {
      method: 'POST',
      body: ticketPayload({
        idempotencyKey: crypto.randomUUID(),
        title: '跨版本：表格文档示例报错',
        pageVersion: '2026.08.0',
        affectedVersions: ['2026.08.0', '2026.09.0']
      })
    })
    id = created.json.ticket.id
    token = created.json.receipt.viewerToken
    const versions = created.json.ticket.affectedVersions.map((v) => v.docVersion).sort()
    assert.deepEqual(versions, ['2026.08.0', '2026.09.0'])
  })

  test('未发布版本不能作为“验证有效”版本', async () => {
    const r = await api(env.base, `/api/maintainer/tickets/${id}/verify`, {
      method: 'POST',
      headers: { Authorization: MONA },
      body: { docVersion: '2026.08.0', verifiedVersion: '2026.10.1' }
    })
    assert.equal(r.status, 409)
    assert.equal(r.json.error, 'verified_version_not_released')
  })

  test('登记修复证据后再在已发布新版本验证，仅该版本 resolved', async () => {
    // 维护者登记新版本发布
    const rel = await api(env.base, '/api/maintainer/releases', {
      method: 'POST', headers: { Authorization: ADMIN }, body: { version: '2026.10.1', notes: '十月修订' }
    })
    assert.equal(rel.status, 200)

    const fix = await api(env.base, `/api/maintainer/tickets/${id}/fix`, {
      method: 'POST', headers: { Authorization: MONA },
      body: { docVersion: '2026.08.0', fixVersion: '2026.10.1', evidence: 'PR#42 修正示例引用' }
    })
    assert.equal(fix.status, 200)

    const ver = await api(env.base, `/api/maintainer/tickets/${id}/verify`, {
      method: 'POST', headers: { Authorization: MONA },
      body: { docVersion: '2026.08.0', verifiedVersion: '2026.10.1' }
    })
    assert.equal(ver.status, 200)

    const t = await api(env.base, `/api/tickets/${id}?token=${token}`)
    const v8 = t.json.affectedVersions.find((v) => v.docVersion === '2026.08.0')
    const v9 = t.json.affectedVersions.find((v) => v.docVersion === '2026.09.0')
    assert.equal(v8.status, 'resolved')
    assert.equal(v8.verifiedVersion, '2026.10.1')
    assert.equal(v8.live, true)
    assert.equal(v9.status, 'open', '另一受影响版本仍未解决')
    assert.equal(v9.live, false)
  })

  test('验收③：旧版仍有问题 → 复开后工单回到 open，事件链保留', async () => {
    const r = await api(env.base, `/api/maintainer/tickets/${id}/reopen`, {
      method: 'POST', headers: { Authorization: RAFA },
      body: { docVersion: '2026.08.0', reason: '2026.08.0 旧版文档未同步补丁，问题仍在' }
    })
    assert.equal(r.status, 200)
    const t = await api(env.base, `/api/tickets/${id}?token=${token}`)
    const v8 = t.json.affectedVersions.find((v) => v.docVersion === '2026.08.0')
    assert.equal(v8.status, 'open')
    assert.equal(t.json.status, 'open')
    // 历史不丢失：fix_submitted / fix_verified / reopened 事件都在
    const types = t.json.events.map((e) => e.type)
    assert.ok(types.includes('fix_submitted'))
    assert.ok(types.includes('fix_verified'))
    assert.ok(types.includes('reopened'))
    // 复开后 verified 信息仍可追溯（行内仍保留历史字段）
    const evVerified = t.json.events.find((e) => e.type === 'fix_verified')
    assert.equal(evVerified.to, '2026.10.1')
  })
})

describe('验收②：两个维护者合并同一工单，来源不丢失且幂等', () => {
  test('mona 与 rafa 对同一对工单重复合并，只产生一次事件，来源可追溯', async () => {
    const a = await api(env.base, '/api/tickets', { method: 'POST', body: ticketPayload({
      idempotencyKey: crypto.randomUUID(), title: '合并来源单 A' }) })
    const b = await api(env.base, '/api/tickets', { method: 'POST', body: ticketPayload({
      idempotencyKey: crypto.randomUUID(), title: '合并目标单 B' }) })
    const sourceId = a.json.ticket.id
    const targetId = b.json.ticket.id

    const body = { sourceId, targetId, reason: '同一根因', idempotencyKey: 'merge-key-001' }
    const r1 = await api(env.base, '/api/maintainer/merge', {
      method: 'POST', headers: { Authorization: MONA }, body })
    // rafa 用同一个幂等键重试（网络回执重复）
    const r2 = await api(env.base, '/api/maintainer/merge', {
      method: 'POST', headers: { Authorization: RAFA }, body })
    // rafa 没用幂等键又合一次（重复合并动作本身也要安全）
    const r3 = await api(env.base, '/api/maintainer/merge', {
      method: 'POST', headers: { Authorization: RAFA },
      body: { sourceId, targetId, reason: '再来一次', idempotencyKey: crypto.randomUUID() } })
    assert.equal(r1.json.result.merged, true)
    assert.equal(r2.json.idempotent_replay, true)
    assert.equal(r3.json.result.merged, false, '合并关系已存在，不重复落事件')

    const src = await api(env.base, `/api/maintainer/tickets/${sourceId}`, {
      headers: { Authorization: MONA } })
    const tgt = await api(env.base, `/api/maintainer/tickets/${targetId}`, {
      headers: { Authorization: MONA } })
    assert.equal(src.json.status, 'merged')
    assert.deepEqual(tgt.json.merges.sources.map((m) => m.ticketId), [sourceId])
    // 来源工单仍可独立查询，事件里有 merged_into
    assert.ok(src.json.events.some((e) => e.type === 'merged_into' && e.to === targetId))
    assert.ok(tgt.json.events.some((e) => e.type === 'merge_source' && e.from === sourceId))
  })
})

describe('验收④：页面迁移人工确认 + 文档删段', () => {
  let ticketId, migId
  test('迁移后旧反馈保留原定位；未确认前不建立新关系', async () => {
    const c = await api(env.base, '/api/tickets', { method: 'POST', body: ticketPayload({
      idempotencyKey: crypto.randomUUID(),
      title: '迁移定位单',
      pageVersion: '2026.07.0',
      pageAnchor: '#old-anchor'
    }) })
    ticketId = c.json.ticket.id

    const prop = await api(env.base, '/api/maintainer/migrations', {
      method: 'POST', headers: { Authorization: MONA },
      body: {
        sourceVersion: '2026.07.0', sourcePath: '/components/button', sourceAnchor: '#old-anchor',
        targetVersion: '2026.10.1', targetPath: '/components/button-v2', targetAnchor: '#new-anchor'
      } })
    migId = prop.json.id

    const before = await api(env.base,
      '/api/public/locations/resolve?version=2026.07.0&path=/components/button&anchor=%23old-anchor')
    assert.equal(before.json.migrated, false)

    // 工单快照未被改写
    const t0 = await api(env.base, `/api/tickets/${ticketId}`)
    assert.equal(t0.json.page.path, '/components/button')
  })

  test('人工确认后解析到新位置，工单追加确认事件，原定位仍保留', async () => {
    const cf = await api(env.base, `/api/maintainer/migrations/${migId}/confirm`, {
      method: 'POST', headers: { Authorization: RAFA }, body: { idempotencyKey: 'mig-confirm-1' } })
    assert.equal(cf.status, 200)
    // 重复确认幂等
    const cf2 = await api(env.base, `/api/maintainer/migrations/${migId}/confirm`, {
      method: 'POST', headers: { Authorization: RAFA }, body: { idempotencyKey: 'mig-confirm-1' } })
    assert.equal(cf2.json.idempotent_replay, true)

    const after = await api(env.base,
      '/api/public/locations/resolve?version=2026.07.0&path=/components/button&anchor=%23old-anchor')
    assert.equal(after.json.migrated, true)
    assert.equal(after.json.current.path, '/components/button-v2')

    const t = await api(env.base, `/api/maintainer/tickets/${ticketId}`, { headers: { Authorization: MONA } })
    assert.equal(t.json.page.path, '/components/button', '原始定位永久保留')
    assert.ok(t.json.events.some((e) => e.type === 'page_migration_confirmed'))
  })

  test('文档删段：记录 section_deleted 事件，工单不被关闭', async () => {
    const c = await api(env.base, '/api/tickets', { method: 'POST', body: ticketPayload({
      idempotencyKey: crypto.randomUUID(),
      title: '指向被删段落的反馈',
      pageVersion: '2026.10.1',
      pagePath: '/guide/quickstart',
      pageAnchor: '#legacy-section',
      headingSnapshot: '旧的安装命令'
    }) })
    const id2 = c.json.ticket.id
    const r = await api(env.base, '/api/maintainer/sections/deleted', {
      method: 'POST', headers: { Authorization: MONA },
      body: { pageVersion: '2026.10.1', pagePath: '/guide/quickstart', pageAnchor: '#legacy-section',
        idempotencyKey: 'sec-del-1' } })
    assert.equal(r.status, 200)
    const t = await api(env.base, `/api/maintainer/tickets/${id2}`, { headers: { Authorization: MONA } })
    assert.ok(t.json.events.some((e) => e.type === 'section_deleted'))
    assert.equal(t.json.status, 'open', '删段不等于问题解决')
    assert.equal(t.json.page.headingSnapshot, '旧的安装命令', '标题快照保留，仍可辨认定位')
  })
})

describe('验收⑤：附件分片上传中断后可恢复，权限默认不公开', () => {
  const CHUNK = 256 * 1024
  const content = Buffer.alloc(CHUNK * 2 + 100, 0x58) // 3 个分片
  let uploadId, ticketId

  test('创建上传并只传部分分片（模拟中断）', async () => {
    const init = await api(env.base, '/api/uploads', { method: 'POST', body: {
      filename: 'error.log', contentType: 'text/plain',
      totalSize: content.length, chunkSize: CHUNK, totalChunks: 3 } })
    uploadId = init.json.uploadId

    const part0 = content.subarray(0, CHUNK)
    const r0 = await api(env.base, `/api/uploads/${uploadId}/chunks/0?size=${part0.length}`, {
      method: 'PUT', raw: true, body: part0 })
    assert.equal(r0.status, 200)
    // 同一分片重复发送：幂等，不重复落库
    const r0b = await api(env.base, `/api/uploads/${uploadId}/chunks/0?size=${part0.length}`, {
      method: 'PUT', raw: true, body: part0 })
    assert.equal(r0b.json.duplicate, true)

    const st = await api(env.base, `/api/uploads/${uploadId}`)
    assert.deepEqual(st.json.receivedChunks, [0])

    await assert.rejects(api(env.base, `/api/uploads/${uploadId}/complete`, {
      method: 'POST', body: {} }).then((r) => {
        if (r.status !== 200) throw new Error('not_complete:' + r.status)
      }))
  })

  test('恢复：查询已收分片，只传缺失分片后完成', async () => {
    const st = await api(env.base, `/api/uploads/${uploadId}`)
    assert.deepEqual(st.json.receivedChunks, [0])
    const part1 = content.subarray(CHUNK, CHUNK * 2)
    const part2 = content.subarray(CHUNK * 2)
    await api(env.base, `/api/uploads/${uploadId}/chunks/1?size=${part1.length}`, {
      method: 'PUT', raw: true, body: part1 })
    await api(env.base, `/api/uploads/${uploadId}/chunks/2?size=${part2.length}`, {
      method: 'PUT', raw: true, body: part2 })
    const done = await api(env.base, `/api/uploads/${uploadId}/complete`, {
      method: 'POST', body: { sha256: sha(content) } })
    assert.equal(done.status, 200)
  })

  test('附件随工单提交后：默认 maintainer_only，公开下载 403，维护者可取回原文', async () => {
    const created = await api(env.base, '/api/tickets', { method: 'POST', body: ticketPayload({
      idempotencyKey: crypto.randomUUID(),
      title: '带附件的反馈',
      uploadIds: [uploadId],
      attachments: [{ uploadId, visibility: 'maintainer_only' }]
    }) })
    ticketId = created.json.ticket.id
    const att = created.json.ticket.attachments[0]
    assert.equal(att.visibility, 'maintainer_only')
    // 公开视图只暴露文件名/大小，不暴露上传者
    assert.equal(att.uploadedBy, undefined)

    const pub = await fetch(`${env.base}/api/public/attachments/${att.id}/download`)
    assert.equal(pub.status, 403)

    const mt = await fetch(`${env.base}/api/maintainer/attachments/${att.id}/download`, {
      headers: { Authorization: MONA } })
    assert.equal(mt.status, 200)
    const got = Buffer.from(await mt.arrayBuffer())
    assert.equal(got.length, content.length)
    assert.equal(sha(got), sha(content), '分片拼回的文件内容一致')

    // 无凭据访问维护者接口 → 401
    const noAuth = await fetch(`${env.base}/api/maintainer/tickets`)
    assert.equal(noAuth.status, 401)
  })
})

describe('直接改状态 vs 依据修复证据生成状态', () => {
  test('手动改 resolved 必须带原因，且不抹掉后续复开/证据事件', async () => {
    const c = await api(env.base, '/api/tickets', { method: 'POST', body: ticketPayload({
      idempotencyKey: crypto.randomUUID(), title: '手动改状态单' }) })
    const id = c.json.ticket.id

    const bad = await api(env.base, `/api/maintainer/tickets/${id}/status`, {
      method: 'POST', headers: { Authorization: MONA },
      body: { status: 'resolved' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.json.error, 'reason_required')

    const ok = await api(env.base, `/api/maintainer/tickets/${id}/status`, {
      method: 'POST', headers: { Authorization: MONA },
      body: { status: 'wont_fix', reason: '该示例已计划下线' } })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.result.status, 'wont_fix')

    // 走证据链到 resolved，再复开；手动状态与证据事件都保留
    await api(env.base, `/api/maintainer/tickets/${id}/fix`, {
      method: 'POST', headers: { Authorization: MONA },
      body: { docVersion: '2026.09.0', fixVersion: '2026.10.1', evidence: '补丁' } })
    await api(env.base, `/api/maintainer/tickets/${id}/verify`, {
      method: 'POST', headers: { Authorization: MONA },
      body: { docVersion: '2026.09.0', verifiedVersion: '2026.10.1' } })
    await api(env.base, `/api/maintainer/tickets/${id}/reopen`, {
      method: 'POST', headers: { Authorization: RAFA },
      body: { docVersion: '2026.09.0', reason: '用户反馈页面仍可访问' } })
    const t = await api(env.base, `/api/maintainer/tickets/${id}`, { headers: { Authorization: MONA } })
    assert.equal(t.json.status, 'open')
    const types = t.json.events.map((e) => e.type)
    assert.ok(types.includes('manual_status_change'))
    assert.ok(types.includes('reopened'))
  })
})

describe('公开修订摘要只取已核实事实', () => {
  test('未验证/未发布修复不能建摘要；发布后公开接口才可查', async () => {
    // 新工单，版本 2026.09.0，修复声称在 2026.11.0（未发布）
    const c = await api(env.base, '/api/tickets', { method: 'POST', body: ticketPayload({
      idempotencyKey: crypto.randomUUID(), title: '摘要核实单',
      pageVersion: '2026.09.0', affectedVersions: ['2026.09.0'] }) })
    const id = c.json.ticket.id

    // 连修复证据都没登记 → 拒绝
    const s0 = await api(env.base, '/api/maintainer/revision-summaries', {
      method: 'POST', headers: { Authorization: MONA },
      body: { ticketId: id, docVersion: '2026.09.0', fixedVersion: '2026.10.1', summary: '提前写好的公告' } })
    assert.equal(s0.status, 409)
    assert.equal(s0.json.error, 'fix_not_verified')

    // 走完证据 + 验证（2026.10.1 已发布）
    await api(env.base, `/api/maintainer/tickets/${id}/fix`, {
      method: 'POST', headers: { Authorization: MONA },
      body: { docVersion: '2026.09.0', fixVersion: '2026.10.1', evidence: 'PR#77' } })
    await api(env.base, `/api/maintainer/tickets/${id}/verify`, {
      method: 'POST', headers: { Authorization: MONA },
      body: { docVersion: '2026.09.0', verifiedVersion: '2026.10.1' } })

    // fixedVersion 与实际验证版不符 → 拒绝
    const s1 = await api(env.base, '/api/maintainer/revision-summaries', {
      method: 'POST', headers: { Authorization: MONA },
      body: { ticketId: id, docVersion: '2026.09.0', fixedVersion: '2026.09.0', summary: 'x' } })
    assert.equal(s1.status, 409)

    const s2 = await api(env.base, '/api/maintainer/revision-summaries', {
      method: 'POST', headers: { Authorization: MONA },
      body: { ticketId: id, docVersion: '2026.09.0', fixedVersion: '2026.10.1',
        summary: '修正按钮示例的事件绑定说明' } })
    assert.equal(s2.status, 200)
    const summaryId = s2.json.result.id

    // 草稿不公开
    const before = await api(env.base, '/api/public/revision-summary')
    assert.equal(before.json.summaries.some((x) => x.summary === '修正按钮示例的事件绑定说明'), false)

    // 发布后公开
    await api(env.base, `/api/maintainer/revision-summaries/${summaryId}/publish`, {
      method: 'POST', headers: { Authorization: MONA }, body: {} })
    const after = await api(env.base, '/api/public/revision-summary')
    const found = after.json.summaries.find((x) => x.summary === '修正按钮示例的事件绑定说明')
    assert.ok(found)
    assert.equal(found.fixedVersion, '2026.10.1')
    // 公开摘要不含工单提交者身份
    assert.equal(found.contact, undefined)
  })
})
