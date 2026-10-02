<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute } from 'vitepress'
import { getReporterToken } from './identity.js'
import { enqueue, loadQueue, autoFlush, flushQueue, removeItem } from './queue.js'
import { uploadFile } from './uploader.js'

declare const __DOCS_VERSION__: string

const route = useRoute()
const open = ref(false)
const tab = ref<'submit' | 'track'>('submit')
const submitting = ref(false)
const notice = ref<{ type: 'ok' | 'err'; text: string } | null>(null)

const form = reactive({
  kind: 'example_failure' as 'example_failure' | 'content_question',
  title: '',
  body: '',
  contact: '',
  files: [] as File[],
  uploadProgress: 0,
  uploading: false
})

const ticketResult = ref<any>(null)
const trackCode = ref('')
const trackError = ref('')
const outbox = ref<any[]>([])

const reporterToken = computed(() => getReporterToken())

function currentContext() {
  const loc = typeof window !== 'undefined' ? window.location : null
  return {
    page_path: route.path || loc?.pathname || '/',
    anchor: (loc?.hash || '').replace(/^#/, '') || null,
    docs_version: typeof __DOCS_VERSION__ !== 'undefined' ? __DOCS_VERSION__ : 'unknown',
    lang: (typeof document !== 'undefined' && document.documentElement.lang) || null,
    env: {
      user_agent: loc?.navigator?.userAgent || '',
      viewport: loc ? `${loc.innerWidth}x${loc.innerHeight}` : null,
      language: loc?.navigator?.language || null,
      timezone: typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : null,
      os: guessOS(loc?.navigator?.userAgent),
      browser: guessBrowser(loc?.navigator?.userAgent),
      url: loc?.href || null
    }
  }
}

function guessOS(ua = '') {
  return /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua)
    ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : null
}
function guessBrowser(ua = '') {
  return /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null
}

async function submit() {
  notice.value = null
  if (!form.title.trim() || !form.body.trim()) {
    notice.value = { type: 'err', text: '请填写标题与问题描述' }
    return
  }
  submitting.value = true
  let attachmentShas: string[] = []
  try {
    if (form.files.length) {
      form.uploading = true
      form.uploadProgress = 0
      for (const f of form.files) {
        const r = await uploadFile(f, {
          reporterToken: reporterToken.value,
          onProgress: (p) => (form.uploadProgress = p)
        })
        attachmentShas.push(r.sha256)
      }
      form.uploading = false
    }
    const ctx = currentContext()
    const item = enqueue({
      kind: form.kind,
      title: form.title,
      body: form.body,
      contact: form.contact || undefined,
      attachments: attachmentShas,
      reporter_token: reporterToken.value,
      ...ctx
    })
    refreshOutbox()
    try {
      await flushQueue(refreshOutbox)
    } catch { /* 离线时留在队列 */ }
    refreshOutbox()
    const done = loadQueue().find((x) => x.id === item.id)
    if (done?.status === 'sent') {
      notice.value = { type: 'ok', text: `已提交，工单号 ${done.response.code}。请保存查询码以便查看回复` }
      form.title = ''; form.body = ''; form.contact = ''; form.files = []
    } else {
      notice.value = { type: 'ok', text: '当前网络不可用，已存入离线队列，恢复后自动提交（不会重复）' }
    }
  } catch (e: any) {
    notice.value = { type: 'err', text: e?.message || '提交失败，可稍后重试' }
  } finally {
    submitting.value = false
    form.uploading = false
  }
}

function onFiles(e: Event) {
  form.files = Array.from((e.target as HTMLInputElement).files || [])
}

async function track() {
  trackError.value = ''
  ticketResult.value = null
  const code = trackCode.value.trim().toUpperCase()
  if (!/^FB-\d+$/.test(code)) {
    trackError.value = '工单号格式应为 FB-000001'
    return
  }
  try {
    const res = await fetch(
      `/api/feedback/tickets/${code}?token=${encodeURIComponent(reporterToken.value)}`
    )
    const data = await res.json()
    if (!res.ok) {
      trackError.value = data.error || '查询失败'
      return
    }
    ticketResult.value = data
  } catch {
    trackError.value = '网络异常，请稍后再试'
  }
}

function refreshOutbox() {
  outbox.value = loadQueue().filter((x) => x.status !== 'sent')
}

const statusText: Record<string, string> = {
  open: '待处理',
  fix_in_review: '修复待验证',
  partially_resolved: '部分版本已解决',
  resolved: '已解决'
}

onMounted(() => {
  refreshOutbox()
  autoFlush(refreshOutbox)
  if (typeof window !== 'undefined') {
    const p = new URLSearchParams(window.location.search)
    if (p.get('ticket')) {
      tab.value = 'track'
      trackCode.value = p.get('ticket')!
      open.value = true
      track()
    }
  }
})
</script>

<template>
  <div class="fb-root">
    <button class="fb-fab" @click="open = !open" :aria-expanded="open">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      反馈工单
    </button>

    <div v-if="open" class="fb-panel" role="dialog" aria-label="文档反馈">
      <div class="fb-tabs">
        <button :class="{ active: tab === 'submit' }" @click="tab = 'submit'">提交反馈</button>
        <button :class="{ active: tab === 'track' }" @click="tab = 'track'">进度查询</button>
        <button class="fb-close" @click="open = false" aria-label="关闭">×</button>
      </div>

      <div v-if="tab === 'submit'" class="fb-body">
        <div class="fb-kind">
          <label><input type="radio" value="example_failure" v-model="form.kind" /> 示例运行失败</label>
          <label><input type="radio" value="content_question" v-model="form.kind" /> 内容疑问</label>
        </div>
        <input v-model="form.title" class="fb-input" maxlength="160" placeholder="标题（一句话说明）" />
        <textarea v-model="form.body" class="fb-input" rows="5" placeholder="复现步骤 / 疑问点（将自动附带当前页面、锚点与浏览器环境）"></textarea>
        <input v-model="form.contact" class="fb-input" placeholder="联系方式（可选，仅维护者可见脱敏展示）" />
        <div class="fb-attach">
          <input type="file" multiple @change="onFiles" />
          <div v-if="form.uploading" class="fb-progress">
            <div class="fb-bar" :style="{ width: form.uploadProgress + '%' }"></div>
            <span>{{ form.uploadProgress }}%（中断后可续传）</span>
          </div>
          <ul v-if="form.files.length" class="fb-filelist">
            <li v-for="f in form.files" :key="f.name">{{ f.name }} · {{ Math.round(f.size / 1024) }}KB</li>
          </ul>
        </div>
        <div v-if="notice" :class="['fb-notice', notice.type]">{{ notice.text }}</div>
        <div v-if="outbox.length" class="fb-outbox">离线队列：{{ outbox.length }} 条待发送</div>
        <button class="fb-submit" :disabled="submitting" @click="submit">
          {{ submitting ? '提交中…' : '提交工单' }}
        </button>
        <p class="fb-privacy">匿名提交，不记录 IP；附件仅你本人凭查询码与维护者可访问。</p>
      </div>

      <div v-else class="fb-body">
        <div class="fb-trackrow">
          <input v-model="trackCode" class="fb-input" placeholder="工单号，如 FB-000001" />
          <button class="fb-submit small" @click="track">查询</button>
        </div>
        <div v-if="trackError" class="fb-notice err">{{ trackError }}</div>
        <div v-if="ticketResult" class="fb-result">
          <div class="fb-rhead">
            <strong>{{ ticketResult.code }}</strong>
            <span :class="['fb-badge', ticketResult.effective_status]">
              {{ statusText[ticketResult.effective_status] || ticketResult.effective_status }}
            </span>
          </div>
          <h4>{{ ticketResult.title }}</h4>
          <table class="fb-table">
            <thead><tr><th>受影响版本</th><th>状态</th><th>修复版本</th><th>证据</th></tr></thead>
            <tbody>
              <tr v-for="v in ticketResult.affected_versions" :key="v.version">
                <td>{{ v.version }}</td>
                <td>{{ { open: '待处理', fix_proposed: '待验证', resolved: '已解决' }[v.state] }}</td>
                <td>{{ v.fix_version || '—' }}<em v-if="v.state==='resolved'">（已在此版本验证）</em></td>
                <td class="fb-ev">{{ v.evidence || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="ticketResult.location?.confirmed_new_location" class="fb-move">
            页面已迁移至：{{ ticketResult.location.confirmed_new_location.path }}
            <template v-if="ticketResult.location.confirmed_new_location.anchor">#{{ ticketResult.location.confirmed_new_location.anchor }}</template>
            （人工确认）
          </div>
          <div v-if="ticketResult.location?.section_deleted" class="fb-move warn">
            原段落已被删除，反馈保留在原定位：{{ ticketResult.location.original_path }}#{{ ticketResult.location.original_anchor }}
          </div>
          <details class="fb-events">
            <summary>处理时间线（{{ ticketResult.events.length }}）</summary>
            <ul>
              <li v-for="e in ticketResult.events" :key="e.id">
                <code>{{ e.type }}</code> · {{ e.at }}
                <span v-if="e.payload?.fix_version"> → {{ e.payload.fix_version }}</span>
                <span v-if="e.payload?.versions?.length"> [{{ e.payload.versions.join(', ') }}]</span>
              </li>
            </ul>
          </details>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fb-root { position: fixed; right: 24px; bottom: 24px; z-index: 999; font-size: 14px; }
.fb-fab {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--vp-button-brand-bg, #409eff); color: #fff; border: none;
  padding: 10px 16px; border-radius: 20px; cursor: pointer;
  box-shadow: 0 4px 14px rgba(0,0,0,.18);
}
.fb-panel {
  position: absolute; right: 0; bottom: 52px; width: 420px; max-width: 90vw;
  max-height: 78vh; overflow: auto; background: var(--vp-bg, #fff);
  border: 1px solid var(--vp-c-divider, #ddd); border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,.18); color: var(--vp-c-text-1, #213547);
}
.fb-tabs { display: flex; border-bottom: 1px solid var(--vp-c-divider, #eee); position: sticky; top: 0; background: inherit; z-index: 1; }
.fb-tabs button { flex: 0 0 auto; padding: 12px 14px; border: 0; background: none; cursor: pointer; color: inherit; }
.fb-tabs button.active { color: #409eff; border-bottom: 2px solid #409eff; }
.fb-close { margin-left: auto; font-size: 20px; line-height: 1; }
.fb-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.fb-kind { display: flex; gap: 16px; }
.fb-input { width: 100%; padding: 8px 10px; border: 1px solid var(--vp-c-divider, #dcdfe6); border-radius: 6px; background: transparent; color: inherit; box-sizing: border-box; }
textarea.fb-input { resize: vertical; }
.fb-progress { position: relative; height: 22px; background: #f0f2f5; border-radius: 4px; overflow: hidden; }
.fb-progress span { position: absolute; inset: 0; text-align: center; line-height: 22px; font-size: 12px; }
.fb-bar { height: 100%; background: #b3d8ff; transition: width .2s; }
.fb-filelist { margin: 6px 0 0; padding-left: 18px; color: var(--vp-c-text-2, #666); font-size: 12px; }
.fb-notice { padding: 8px 10px; border-radius: 6px; font-size: 13px; }
.fb-notice.ok { background: #f0f9eb; color: #529b2e; }
.fb-notice.err { background: #fef0f0; color: #c45656; }
.fb-outbox { font-size: 12px; color: #b88230; }
.fb-submit { background: #409eff; color: #fff; border: none; padding: 9px 16px; border-radius: 6px; cursor: pointer; }
.fb-submit.small { flex: 0 0 auto; }
.fb-submit:disabled { opacity: .6; cursor: default; }
.fb-privacy { margin: 0; font-size: 12px; color: var(--vp-c-text-2, #999); }
.fb-trackrow { display: flex; gap: 8px; }
.fb-rhead { display: flex; justify-content: space-between; align-items: center; }
.fb-badge { padding: 2px 10px; border-radius: 10px; font-size: 12px; }
.fb-badge.open { background: #f4f4f5; color: #606266; }
.fb-badge.fix_in_review { background: #fdf6ec; color: #b88230; }
.fb-badge.partially_resolved { background: #ecf5ff; color: #337ecc; }
.fb-badge.resolved { background: #f0f9eb; color: #529b2e; }
.fb-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.fb-table th, .fb-table td { border: 1px solid var(--vp-c-divider, #ebeef5); padding: 5px 7px; text-align: left; vertical-align: top; }
.fb-ev { max-width: 120px; word-break: break-all; }
.fb-move { font-size: 12px; padding: 6px 8px; background: #f0f9eb; border-radius: 4px; }
.fb-move.warn { background: #fef0f0; color: #c45656; }
.fb-events summary { cursor: pointer; font-size: 13px; }
.fb-events ul { padding-left: 16px; font-size: 12px; color: var(--vp-c-text-2, #666); }
.dark .fb-progress { background: #2a2a2a; }
</style>
