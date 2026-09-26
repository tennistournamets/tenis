// Messenger share links for a tournament page. Each channel tags the URL with utm_source,
// so analytics shows which messenger brings people in.

export const SHARE_CHANNELS = ['whatsapp', 'telegram', 'viber', 'email']

export function taggedUrl(url, source, medium = 'share') {
  const tagged = new URL(url)
  tagged.searchParams.set('utm_source', source)
  tagged.searchParams.set('utm_medium', medium)
  return tagged.toString()
}

/** href that opens the channel with the message prefilled. */
export function shareHref(channel, { url, text, subject = '' }) {
  const link = taggedUrl(url, channel)
  const message = `${text} ${link}`
  switch (channel) {
    case 'whatsapp': return `https://wa.me/?text=${encodeURIComponent(message)}`
    case 'telegram': return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`
    case 'viber': return `viber://forward?text=${encodeURIComponent(message)}`
    case 'email': return `mailto:?subject=${encodeURIComponent(subject || text)}&body=${encodeURIComponent(message)}`
    default: throw new Error(`Unknown share channel ${channel}`)
  }
}
