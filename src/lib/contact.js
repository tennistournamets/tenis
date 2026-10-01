// Organizers' contact address: the landing button, the footer and the legal pages.
export const CONTACT_EMAIL = 'tennis.tournamets@gmail.com'

export function contactMailto(subject = 'Bracketa') {
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`
}
