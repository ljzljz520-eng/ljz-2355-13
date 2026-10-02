<script setup lang="ts">
import { ref, onMounted } from 'vue'
const data = ref<any>(null)
const error = ref('')
const loading = ref(true)

onMounted(async () => {
  try {
    const res = await fetch('/api/feedback/changelog')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    data.value = await res.json()
  } catch (e: any) {
    error.value = '修订摘要暂不可用（反馈服务未启动时不展示任何条目）'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="fb-changelog">
    <p class="fb-note">
      本页仅汇总<strong>已由维护者在新版本验证、且该版本已发布</strong>的反馈修复。
      未发布或尚未验证的修复不会出现在这里。
    </p>
    <div v-if="loading">加载中…</div>
    <div v-else-if="error" class="fb-err">{{ error }}</div>
    <div v-else>
      <div v-for="(entries, version) in data.versions" :key="version" class="fb-ver">
        <h3>v{{ version }}</h3>
        <ul>
          <li v-for="e in entries" :key="e.ticket + e.affected_version">
            <a :href="`/feedback/?ticket=${e.ticket}`">{{ e.ticket }}</a>
            <span class="fb-kind">{{ e.kind === 'example_failure' ? '示例修复' : '内容更正' }}</span>
            {{ e.title }}
            <span class="fb-av">（{{ e.affected_version }} 反馈 → v{{ e.fixed_in }} 验证）</span>
            <span v-if="e.location?.redirected" class="fb-redir">页面已迁移</span>
            <span v-if="e.location?.section_deleted" class="fb-del">原段落已删除</span>
          </li>
        </ul>
      </div>
      <p v-if="!Object.keys(data.versions || {}).length" class="fb-empty">暂无已发布的核实修复。</p>
    </div>
  </div>
</template>

<style scoped>
.fb-note { color: var(--vp-c-text-2, #666); font-size: 14px; }
.fb-err { color: #c45656; }
.fb-ver h3 { border-bottom: 1px solid var(--vp-c-divider, #eee); padding-bottom: 6px; }
.fb-kind { display: inline-block; font-size: 12px; padding: 0 6px; margin: 0 6px; border-radius: 8px; background: #ecf5ff; color: #337ecc; }
.fb-av { color: var(--vp-c-text-2, #999); font-size: 12px; }
.fb-redir, .fb-del { font-size: 12px; margin-left: 6px; padding: 0 6px; border-radius: 8px; }
.fb-redir { background: #f0f9eb; color: #529b2e; }
.fb-del { background: #fef0f0; color: #c45656; }
</style>
