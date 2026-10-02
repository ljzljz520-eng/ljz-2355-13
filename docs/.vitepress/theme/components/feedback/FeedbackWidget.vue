<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  collectEnv, fetchReceipt, findAnchorContext, newIdempotencyKey,
  publicSummaries, submitTicket, uploadAttachment
} from './api'
import {
  enqueue, getReceipts, loadQueue, processQueue, rememberFiles,
  removeItem, saveReceipt, takeFiles, type QueuedItem
} from './queue'

type Category = 'example_failure' | 'content_question' | 'other'

const open = ref(false)
const tab = ref<'form' | 'receipt' | 'queue' | 'summary'>('form')

declare const __DOC_VERSION__: string
const docVersion = ref(
  (globalThis as { __DOC_VERSION__?: string }).__DOC_VERSION__ ?? 'dev'
)
const category = ref<Category>('example_failure')
const title = ref('')
const body = ref('')
const contact = ref('')
const makeContactPublic = ref(false)
const files = ref<File[]>([])
const submitting = ref(false)
const progress = ref('')
const message = ref<{ ok: boolean; text: string } | null>(null)

const online = ref(typeof navigator !== 'undefined' ? navigator.onLine : true)
const queue = ref<QueuedItem[]>([])
const receipts = ref<Record<string, string>>({})
const receiptQuery = ref('')
const receiptResult = ref<any>(null)
const summaries = ref<any[]>([])

const categories: Record<Category, string> = {
  example_failure: '示例运行失败',
  content_question: '内容疑问',
  other: '其他'
}

const currentLoc = computed(() => {
  const { anchor, heading } = findAnchorContext()
  return {
    path: typeof location !== 'undefined' ? location.pathname.replace(/\.html$/, '') : '/',
    anchor,
    heading
  }
})

function refreshQueue() {
  queue.value = loadQueue()
  receipts.value = getReceipts()
}

onMounted(() => {
  refreshQueue()
  window.addEventListener('online', () => { online.value = true; flushQueue() })
  window.addEventListener('offline', () => { online.value = false })
})

function pickFiles(e: Event) {
  const list = Array.from((e.target as HTMLInputElement).files || [])
  files.value = list
}

function reset() {
  title.value = ''; body.value = ''; contact.value = ''
  makeContactPublic.value = false; files.value = []; progress.value = ''; message.value = null
}

// 构造提交体（页面版/锚点/环境声明在提交瞬间采集）
function buildDraft() {
  const loc = currentLoc.value
  return {
    category: category.value,
    title: title.value.trim(),
    body: body.value.trim(),
    contact: contact.value.trim() || undefined,
    contactDisplay: (makeContactPublic.value ? 'public' : 'private') as 'public' | 'private',
    pageVersion: docVersion.value,
    pagePath: loc.path,
    pageAnchor: loc.anchor,
    headingSnapshot: loc.heading,
    affectedVersions: [docVersion.value],
    env: collectEnv(docVersion.value),
    attachments: files.value.map((f) => ({
      file: f,
      // 最小披露：附件默认仅维护者可见
      visibility: 'maintainer_only' as const
    }))
  }
}

async function onSubmit() {
  if (!title.value.trim() || !body.value.trim()) {
    message.value = { ok: false, text: '请填写标题与问题描述' }
    return
  }
  submitting.value = true
  message.value = null
  const key = newIdempotencyKey()

  try {
    if (online.value) {
      // 在线：先传附件（中断会抛错，自动落入离线队列，幂等键不变）
      const uploadIds: string[] = []
      try {
        for (const f of files.value) {
          const { uploadId } = await uploadAttachment(f, (done, total) => {
            progress.value = `正在上传 ${f.name}：${Math.round((done / total) * 100)}%`
          })
          uploadIds.push(uploadId)
        }
      } catch (upErr) {
        // 上传中断：连同已建会话转入离线队列，恢复后续传，不丢已传分片
        enqueue({
          idempotencyKey: key,
          draft: buildDraft(),
          files: files.value.map((f, i) => ({
            name: f.name, size: f.size, contentType: f.type,
            visibility: 'maintainer_only', uploadId: uploadIds[i]
          })),
          status: 'queued',
          createdAt: Date.now()
        })
        rememberFiles(key, files.value)
        refreshQueue()
        message.value = { ok: false, text: '附件上传中断，反馈已保存到本机队列，网络恢复后自动续传提交。' }
        open.value = false
        reset()
        return
      }
      const draft = buildDraft()
      const res = await submitTicket(draft, key, uploadIds)
      saveReceipt(res.ticket.id, res.receipt.viewerToken)
      message.value = {
        ok: true,
        text: `提交成功${res.idempotent_replay ? '（重复回执，返回原工单）' : ''}：工单号 ${res.ticket.id}，请保存查询回执。`
      }
      reset()
      refreshQueue()
    } else {
      // 离线：幂等键在本地生成并持久化
      enqueue({
        idempotencyKey: key,
        draft: buildDraft(),
        files: files.value.map((f) => ({
          name: f.name, size: f.size, contentType: f.type, visibility: 'maintainer_only'
        })),
        status: 'queued',
        createdAt: Date.now()
      })
      rememberFiles(key, files.value)
      message.value = { ok: true, text: '当前离线，反馈已存入本机队列（含幂等键），联网后自动提交，不会重复。' }
      reset()
      refreshQueue()
      open.value = false
    }
  } catch (e) {
    message.value = { ok: false, text: '提交失败：' + (e as Error).message + '（可稍后在“待提交”中重试）' }
  } finally {
    submitting.value = false
    progress.value = ''
  }
}

// 立即把当前表单也放入队列（用户主动“离线保存”）
function saveOffline() {
  if (!title.value.trim() || !body.value.trim()) return
  const key = newIdempotencyKey()
  enqueue({
    idempotencyKey: key,
    draft: buildDraft(),
    files: files.value.map((f) => ({
      name: f.name, size: f.size, contentType: f.type, visibility: 'maintainer_only'
    })),
    status: 'queued',
    createdAt: Date.now()
  })
  rememberFiles(key, files.value)
  reset()
  refreshQueue()
  message.value = { ok: true, text: '已保存到待提交队列。' }
}

async function flushQueue() {
  if (!online.value || !loadQueue().length) return
  progress.value = '正在提交离线反馈…'
  const results = await processQueue(({ phase, pct }) => { progress.value = `${phase} ${pct}%` })
  refreshQueue()
  progress.value = ''
  const bad = results.filter((r) => !r.ok)
  message.value = bad.length
    ? { ok: false, text: '部分反馈仍未提交：' + bad.map((b) => b.error).join(', ') }
    : (results.length ? { ok: true, text: '离线反馈已全部提交。' } : null)
}

function discardQueued(key: string) {
  removeItem(key)
  refreshQueue()
}

async function queryReceipt() {
  const [id, token] = receiptQuery.value.trim().split(/\s+/)
  if (!id || !token) {
    message.value = { ok: false, text: '请输入：工单号 回执令牌（空格分隔）' }
    return
  }
  receiptResult.value = await fetchReceipt(id, token)
}

async function loadSummaries() {
  const r = await publicSummaries()
  summaries.value = r.summaries
}
</script>

<template>
  <div class="fb-root">
    <button class="fb-fab" @click="open = !open" :title="'文档反馈'">
      <span v-if="queue.length" class="fb-badge">{{ queue.length }}</span>
      💬 反馈
    </button>

    <div v-if="open" class="fb-panel">
      <div class="fb-head">
        <strong>文档反馈</strong>
        <div>
          <span :class="['fb-dot', online ? 'on' : 'off']"></span>
          <span class="fb-net">{{ online ? '在线' : '离线' }}</span>
          <button class="fb-x" @click="open = false">×</button>
        </div>
      </div>

      <div class="fb-tabs">
        <button :class="{ active: tab === 'form' }" @click="tab = 'form'">提交</button>
        <button :class="{ active: tab === 'receipt' }" @click="tab = 'receipt'">回执查询</button>
        <button :class="{ active: tab === 'queue' }" @click="tab = 'queue'; refreshQueue()">
          待提交<span v-if="queue.length" class="fb-cnt">{{ queue.length }}</span>
        </button>
        <button :class="{ active: tab === 'summary' }" @click="tab = 'summary'; loadSummaries()">修订摘要</button>
      </div>

      <div v-if="message" :class="['fb-msg', message.ok ? 'ok' : 'err']">{{ message.text }}</div>

      <!-- 提交表单 -->
      <div v-show="tab === 'form'" class="fb-body">
        <label>问题类型</label>
        <select v-model="category">
          <option v-for="(label, key) in categories" :key="key" :value="key">{{ label }}</option>
        </select>

        <label>标题</label>
        <input v-model="title" maxlength="200" placeholder="一句话说明问题" />

        <label>描述（示例失败请贴报错信息/复现步骤）</label>
        <textarea v-model="body" rows="5" maxlength="10000"></textarea>

        <label>截图/日志附件（可选，默认仅维护者可见）</label>
        <input type="file" multiple @change="pickFiles" />
        <div v-if="files.length" class="muted">
          {{ files.map((f) => f.name).join(', ') }}
        </div>

        <label>联系方式（可选，留名即匿名；默认不公开）</label>
        <input v-model="contact" placeholder="邮箱/昵称，可留空" />
        <label class="fb-check">
          <input type="checkbox" v-model="makeContactPublic" /> 允许在公开页面显示我的联系方式
        </label>

        <div class="muted fb-env">
          将随反馈保存：页面版 <code>{{ docVersion }}</code> ·
          路径 <code>{{ currentLoc.path }}{{ currentLoc.anchor || '' }}</code>
          <template v-if="currentLoc.heading"> · 段落「{{ currentLoc.heading }}」</template>
          与浏览器环境声明（语言、视口等，用于复现，不用于追踪）。
        </div>
        <div v-if="progress" class="muted">{{ progress }}</div>

        <div class="fb-actions">
          <button class="fb-primary" :disabled="submitting" @click="onSubmit">
            {{ submitting ? '提交中…' : '提交反馈' }}
          </button>
          <button class="fb-ghost" @click="saveOffline">先存本机</button>
        </div>
      </div>

      <!-- 回执查询 -->
      <div v-show="tab === 'receipt'" class="fb-body">
        <p class="muted">提交成功后获得工单号与私密回执令牌，请自行保存。公开页面不显示提交者身份。</p>
        <input v-model="receiptQuery" placeholder="TKT-000001 回执令牌" />
        <div class="fb-actions"><button class="fb-primary" @click="queryReceipt">查询</button></div>

        <div v-if="receiptResult" class="fb-receipt">
          <h4>{{ receiptResult.title }}
            <span :class="['tag', receiptResult.status]">{{ receiptResult.status }}</span>
          </h4>
          <div v-for="v in receiptResult.affectedVersions" :key="v.docVersion" class="fb-ver">
            版本 {{ v.docVersion }}：{{ v.status }}
            <template v-if="v.fixVersion"> · 修复版 {{ v.fixVersion }}</template>
            <template v-if="v.verifiedVersion">
              · 验证版 {{ v.verifiedVersion }}
              <span :class="['pill', v.live ? 'live' : 'notlive']">
                {{ v.live ? '已上线' : '尚未上线' }}
              </span>
            </template>
          </div>
          <details>
            <summary>处理事件（{{ receiptResult.events.length }}）</summary>
            <div v-for="(e, i) in receiptResult.events" :key="i" class="fb-ev">
              {{ e.type }} {{ e.actor }} {{ e.to || '' }} {{ e.docVersion ? '[' + e.docVersion + ']' : '' }}
            </div>
          </details>
        </div>

        <div v-if="Object.keys(receipts).length" class="muted">
          本机回执：
          <div v-for="(token, id) in receipts" :key="id">
            <a href="#" @click.prevent="receiptQuery = id + ' ' + token; queryReceipt()">{{ id }}</a>
          </div>
        </div>
      </div>

      <!-- 离线队列 -->
      <div v-show="tab === 'queue'" class="fb-body">
        <p class="muted">
          离线或上传中断的反馈保存在本机，带有幂等键；联网后可自动/手动提交，
          重复网络回执不会创建重复工单，已传分片不重传。
        </p>
        <div class="fb-actions">
          <button class="fb-primary" :disabled="!online" @click="flushQueue">立即提交全部</button>
        </div>
        <div v-for="item in queue" :key="item.idempotencyKey" class="fb-q">
          <div><strong>{{ item.draft.title || '(无标题)' }}</strong></div>
          <div class="muted">
            {{ item.draft.pageVersion }} · {{ item.draft.pagePath }}{{ item.draft.pageAnchor || '' }}
            · {{ item.status }} <template v-if="item.error">（{{ item.error }}）</template>
          </div>
          <div class="muted">幂等键：<code>{{ item.idempotencyKey.slice(0, 13) }}…</code></div>
          <div v-if="item.files.length" class="muted">
            附件：{{ item.files.map((f) => f.name + (f.uploadId ? '（可续传）' : '')).join(', ') }}
          </div>
          <div class="fb-actions">
            <button class="fb-ghost small" :disabled="!online" @click="flushQueue">重试</button>
            <button class="fb-ghost small" @click="discardQueued(item.idempotencyKey)">删除</button>
          </div>
        </div>
        <p v-if="!queue.length" class="muted">没有待提交反馈。</p>
      </div>

      <!-- 公开修订摘要：只含已核实事实 -->
      <div v-show="tab === 'summary'" class="fb-body">
        <p class="muted">以下条目均为已发布版本中验证有效的修复；未发布/未验证修复不会在此出现。</p>
        <div v-for="(s, i) in summaries" :key="i" class="fb-q">
          <strong>{{ s.summary }}</strong>
          <div class="muted">{{ s.docVersion }} 的问题已在 {{ s.fixedVersion }} 修复并验证上线</div>
        </div>
        <p v-if="!summaries.length" class="muted">暂无公开修订。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fb-root { position: fixed; right: 24px; bottom: 24px; z-index: 999; font-size: 14px; }
.fb-fab {
  background: #409eff; color: #fff; border: none; border-radius: 20px; padding: 10px 18px;
  cursor: pointer; box-shadow: 0 4px 16px rgba(64,158,255,.35); position: relative;
}
.fb-badge {
  position: absolute; top: -6px; right: -6px; background: #f56c6c; color: #fff;
  border-radius: 10px; font-size: 11px; padding: 0 6px;
}
.fb-panel {
  position: absolute; bottom: 52px; right: 0; width: 380px; max-height: 78vh; overflow: auto;
  background: #fff; border: 1px solid #dcdfe6; border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.12);
}
.fb-head { display: flex; justify-content: space-between; align-items: center; padding: 12px 14px; border-bottom: 1px solid #ebeef5; }
.fb-x { border: none; background: none; font-size: 18px; cursor: pointer; color: #909399; }
.fb-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.fb-dot.on { background: #67c23a; } .fb-dot.off { background: #e6a23c; }
.fb-net { color: #909399; font-size: 12px; margin-right: 8px; }
.fb-tabs { display: flex; border-bottom: 1px solid #ebeef5; }
.fb-tabs button { flex: 1; border: none; background: none; padding: 8px; cursor: pointer; color: #606266; }
.fb-tabs button.active { color: #409eff; border-bottom: 2px solid #409eff; }
.fb-cnt { background: #f56c6c; color: #fff; border-radius: 8px; font-size: 11px; padding: 0 5px; margin-left: 2px; }
.fb-body { padding: 12px 14px; }
.fb-body label { display: block; font-size: 12px; color: #606266; margin: 8px 0 4px; }
.fb-body input[type=text], .fb-body input:not([type]), .fb-body select, .fb-body textarea {
  width: 100%; padding: 7px 10px; border: 1px solid #dcdfe6; border-radius: 4px; font: inherit;
}
.fb-check { display: flex; align-items: center; gap: 6px; }
.fb-check input { width: auto; }
.fb-actions { display: flex; gap: 8px; margin-top: 12px; }
.fb-primary { background: #409eff; color: #fff; border: none; border-radius: 4px; padding: 8px 16px; cursor: pointer; }
.fb-primary:disabled { opacity: .5; cursor: default; }
.fb-ghost { background: #fff; color: #606266; border: 1px solid #dcdfe6; border-radius: 4px; padding: 8px 12px; cursor: pointer; }
.fb-ghost.small { padding: 4px 10px; font-size: 12px; }
.fb-msg { margin: 8px 14px 0; padding: 8px 10px; border-radius: 4px; font-size: 12px; }
.fb-msg.ok { background: #f0f9eb; color: #67c23a; }
.fb-msg.err { background: #fef0f0; color: #f56c6c; }
.muted { color: #909399; font-size: 12px; margin: 4px 0; }
.fb-env { margin-top: 8px; line-height: 1.6; }
code { background: #f4f4f5; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
.fb-q { border: 1px solid #ebeef5; border-radius: 6px; padding: 8px 10px; margin: 8px 0; }
.tag { font-size: 11px; padding: 1px 8px; border-radius: 8px; background: #ecf5ff; color: #409eff; margin-left: 6px; }
.tag.resolved { background: #f0f9eb; color: #67c23a; }
.tag.open, .tag.fix_submitted { background: #fdf6ec; color: #e6a23c; }
.pill { font-size: 11px; padding: 0 6px; border-radius: 8px; margin-left: 4px; }
.pill.live { background: #f0f9eb; color: #67c23a; }
.pill.notlive { background: #fdf6ec; color: #e6a23c; }
.fb-ev { font-size: 11px; color: #909399; padding: 2px 0; }
.fb-ver { font-size: 12px; margin: 4px 0; }
</style>
