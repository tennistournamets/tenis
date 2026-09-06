import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const privateNames = Object.keys(env).filter(key => /PASSWORD|SECRET|SERVICE_ROLE|DATABASE|DB_/i.test(key))
  if (privateNames.length) throw new Error(`Private credentials must not use the public VITE_ prefix: ${privateNames.join(', ')}`)
  return {
    plugins: [vue()],
    // All translations use the Composition API; keep the message compiler for
    // runtime RU/EN/LT switching, omit unused legacy API and template helpers.
    define: { __VUE_I18N_FULL_INSTALL__: false, __VUE_I18N_LEGACY_API__: false },
    server: { host: true, port: 5173 },
  }
})
