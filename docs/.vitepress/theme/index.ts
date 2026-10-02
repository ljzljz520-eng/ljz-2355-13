import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import VpDemo from './components/VpDemo.vue'
import VpApi from './components/VpApi.vue'
import BaseButton from './components/BaseButton.vue'
import FeedbackWidget from './components/feedback/FeedbackWidget.vue'
import './custom.css'

export default {
  extends: DefaultTheme,
  Layout() {
    // 反馈浮标挂载于所有页面（公开访客可见，无需登录）
    return h(DefaultTheme.Layout, null, {
      'layout-bottom': () => h(FeedbackWidget)
    })
  },
  enhanceApp({ app }) {
    app.component('VpDemo', VpDemo)
    app.component('VpApi', VpApi)
    app.component('BaseButton', BaseButton)

    // Auto register examples
    const examples = import.meta.glob('../../examples/**/*.vue', { eager: true })
    for (const path in examples) {
      const name = path
        .replace('../../examples/', 'demo-')
        .replace(/\//g, '-')
        .replace('.vue', '')
      app.component(name, (examples[path] as any).default)
    }
  }
}
