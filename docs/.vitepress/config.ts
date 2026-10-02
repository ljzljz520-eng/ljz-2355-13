import { defineConfig } from 'vitepress'
import mdContainer from 'markdown-it-container'
import fs from 'fs'
import path from 'path'

// 页面版：每次构建携带一个版本号，反馈接口据此区分同一问题是否跨多版本出现
const DOC_VERSION = process.env.DOC_VERSION || `dev-${new Date().toISOString().slice(0, 10)}`

export default defineConfig({
  title: 'My Component Lib',
  description: 'A UI Component Library based on Vue 3',
  lastUpdated: true,
  cleanUrls: true,
  appearance: true,

  vite: {
    define: {
      __DOC_VERSION__: JSON.stringify(DOC_VERSION)
    },
    server: {
      // 本地开发：把 /feedback-api 代理到工单服务（node server）
      proxy: {
        '/feedback-api': {
          target: process.env.FEEDBACK_TARGET || 'http://localhost:8788',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/feedback-api/, '/api')
        }
      }
    }
  },

  markdown: {
    config: (md) => {
      md.use(mdContainer, 'demo', {
        validate(params) {
          return !!params.trim().match(/^demo\s*(.*)$/)
        },
        render(tokens, idx) {
          if (tokens[idx].nesting === 1) {
            const m = tokens[idx].info.trim().match(/^demo\s*(.*)$/)
            const description = m && m.length > 1 ? m[1] : ''

            let i = idx + 1
            let sourceFile = ''
            while (tokens[i] && tokens[i].nesting !== -1) {
              if (tokens[i].type === 'inline' || tokens[i].type === 'text') {
                sourceFile = tokens[i].content.trim()
                break
              }
              i++
            }

            let source = ''
            if (sourceFile) {
              const filePath = path.resolve('docs', sourceFile)
              if (fs.existsSync(filePath)) {
                source = fs.readFileSync(filePath, 'utf-8')
              } else {
                return `<div class="danger custom-block"><p class="custom-block-title">Demo Error</p><p>File not found: <code>${sourceFile}</code></p></div>`
              }
            }

            const name = sourceFile?.replace(/\//g, '-').replace('.vue', '')

            return `<VpDemo>
              ${description ? `<template #description>${md.render(description)}</template>` : ''}
              <template #source>
                ${md.render(`\`\`\`vue\n${source}\n\`\`\``)}
              </template>
              <demo-${name} />
            </VpDemo>\n`
          }
          return ''
        }
      })
    }
  },

  locales: {
    root: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [
          { text: '指南', link: '/guide/installation', activeMatch: '/guide/' },
          { text: '组件', link: '/components/button', activeMatch: '/components/' },
          { text: '反馈说明', link: '/feedback/overview', activeMatch: '/feedback/' }
        ],
        sidebar: {
          '/guide/': [
            {
              text: '基础',
              items: [
                { text: '安装', link: '/guide/installation' },
                { text: '快速开始', link: '/guide/quickstart' }
              ]
            }
          ],
          '/components/': [
            {
              text: '基础组件',
              items: [
                { text: 'Button 按钮', link: '/components/button' }
              ]
            }
          ],
          '/feedback/': [
            {
              text: '反馈工单',
              items: [
                { text: '反馈功能说明', link: '/feedback/overview' }
              ]
            }
          ]
        },
        footer: {
          message: '基于 MIT 许可发布',
          copyright: '版权所有 © 2024-至今'
        }
      }
    },
    en: {
      label: 'English',
      lang: 'en-US',
      link: '/en/',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/en/guide/installation', activeMatch: '/en/guide/' },
          { text: 'Components', link: '/en/components/button', activeMatch: '/en/components/' }
        ],
        sidebar: {
          '/en/guide/': [
            {
              text: 'Basic',
              items: [
                { text: 'Installation', link: '/en/guide/installation' },
                { text: 'Quick Start', link: '/en/guide/quickstart' }
              ]
            }
          ],
          '/en/components/': [
            {
              text: 'Basic Components',
              items: [
                { text: 'Button', link: '/en/components/button' }
              ]
            }
          ]
        },
        footer: {
          message: 'Released under the MIT License.',
          copyright: 'Copyright © 2024-present'
        }
      }
    }
  },

  themeConfig: {
    search: {
      provider: 'local'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/vuejs/vitepress' }
    ]
  }
})
