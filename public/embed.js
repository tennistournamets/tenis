/*
 * Bracketa widget for club websites.
 *   <div data-bracketa-tournament="SLUG"><a href="https://…/tournaments/SLUG">…</a></div>
 *   <script src="https://…/embed.js" async></script>
 * Optional attributes on the div: data-lang="ru|en|lt", data-theme="light|dark", data-height="640".
 * The link stays on the host page (visible under the widget and without JavaScript).
 */
(function () {
  var script = document.currentScript
  var origin = script && script.src ? new URL(script.src).origin : ''
  if (!origin) return
  var state = window.__bracketaEmbed || (window.__bracketaEmbed = { frames: [], listening: false })

  function mount(box) {
    if (box.getAttribute('data-bracketa-mounted')) return
    var slug = box.getAttribute('data-bracketa-tournament')
    if (!slug) return
    box.setAttribute('data-bracketa-mounted', '1')
    var params = []
    var lang = box.getAttribute('data-lang')
    var theme = box.getAttribute('data-theme')
    if (lang === 'ru' || lang === 'en' || lang === 'lt') params.push('lang=' + lang)
    if (theme === 'light' || theme === 'dark') params.push('theme=' + theme)
    var iframe = document.createElement('iframe')
    iframe.src = origin + '/embed/' + encodeURIComponent(slug) + (params.length ? '?' + params.join('&') : '')
    iframe.title = (box.textContent || '').trim() || 'Bracketa'
    iframe.loading = 'lazy'
    iframe.setAttribute('allow', 'fullscreen')
    var height = parseInt(box.getAttribute('data-height'), 10) || 640
    iframe.style.cssText = 'display:block;width:100%;height:' + height + 'px;border:0;border-radius:12px;background:transparent'
    box.insertBefore(iframe, box.firstChild)
    var link = box.querySelector('a')
    if (link) link.style.cssText = 'display:block;margin-top:6px;text-align:right;font-size:12px;opacity:.75'
    state.frames.push(iframe)
  }

  if (!state.listening) {
    state.listening = true
    window.addEventListener('message', function (event) {
      var data = event.data
      if (event.origin !== origin || !data || data.type !== 'bracketa:embed-height') return
      for (var i = 0; i < state.frames.length; i++) {
        if (state.frames[i].contentWindow === event.source) {
          state.frames[i].style.height = Math.max(160, Math.min(Number(data.height) || 0, 20000)) + 'px'
        }
      }
    })
  }

  var boxes = document.querySelectorAll('[data-bracketa-tournament]')
  for (var i = 0; i < boxes.length; i++) mount(boxes[i])
})()
