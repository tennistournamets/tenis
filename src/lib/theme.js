import { ref } from 'vue'

// data-theme на <html> уже выставлен инлайн-скриптом в index.html.
export const theme = ref(document.documentElement.dataset.theme || 'light')

export function setTheme(next) {
  theme.value = next
  document.documentElement.dataset.theme = next
  try {
    localStorage.setItem('champ_theme', next)
  } catch {
    /* ignore */
  }
}

export function toggleTheme() {
  setTheme(theme.value === 'dark' ? 'light' : 'dark')
}

// Пока пользователь не выбрал тему вручную — следуем за системной.
try {
  if (!localStorage.getItem('champ_theme')) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('champ_theme')) {
        theme.value = e.matches ? 'dark' : 'light'
        document.documentElement.dataset.theme = theme.value
      }
    })
  }
} catch {
  /* ignore */
}
