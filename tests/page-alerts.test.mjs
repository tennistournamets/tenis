import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick, ref } from 'vue'
import { NOTICE_MS, usePageAlerts } from '../src/lib/pageAlerts.js'

const flush = async () => { await nextTick(); await nextTick() }

test('notices disappear by themselves; errors stay until the user acts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const errorText = ref(''), noticeText = ref(''), activeTab = ref('entries')
  const stop = usePageAlerts({ errorText, noticeText, activeTab })
  noticeText.value = 'Подтверждены все заявки: 4.'; errorText.value = 'Мест нет'
  await flush()
  t.mock.timers.tick(NOTICE_MS - 1); assert.equal(noticeText.value, 'Подтверждены все заявки: 4.')
  t.mock.timers.tick(1); assert.equal(noticeText.value, '')
  assert.equal(errorText.value, 'Мест нет')
  stop()
})

test('banners of one tab do not follow the organizer to another tab', async () => {
  const errorText = ref('x'), noticeText = ref('Черновик возвращён к опубликованному расписанию.'), activeTab = ref('schedule')
  let fullPageError = false
  const stop = usePageAlerts({ errorText, noticeText, activeTab, keepError: () => fullPageError })
  activeTab.value = 'settings'; await flush()
  assert.equal(noticeText.value, ''); assert.equal(errorText.value, '')
  fullPageError = true; errorText.value = 'no access'; activeTab.value = 'entries'; await flush()
  assert.equal(errorText.value, 'no access')
  stop()
})

test('an error raised off-screen is scrolled into view', async () => {
  const calls = []
  const el = { getBoundingClientRect: () => ({ top: -500, bottom: -440 }), scrollIntoView: opts => calls.push(opts) }
  const errorText = ref(''), noticeText = ref('')
  const stop = usePageAlerts({ errorText, noticeText, alertEl: ref(el), win: { innerHeight: 800 } })
  errorText.value = 'Мест нет: лимит участников достигнут.'; await flush()
  assert.equal(calls.length, 1)
  el.getBoundingClientRect = () => ({ top: 100, bottom: 160 })
  errorText.value = ''; await flush(); errorText.value = 'again'; await flush()
  assert.equal(calls.length, 1, 'a visible banner is not scrolled to')
  stop()
})
