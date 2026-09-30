// Full IndexNow resubmit of every indexable URL: landings, blog, public tournaments.
// Run after a deploy that changes the landing or the blog:  npm run indexnow
// SITE_URL defaults to https://braketa.top; Supabase URL/anon key come from .env (optional).
import { existsSync, readFileSync } from 'node:fs'
import { normalizeOrigin } from '../src/lib/seo.js'
import { collectUrls, submitUrls } from '../api/_indexnow.js'

const env = { ...process.env }
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (match && env[match[1]] === undefined) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
}

const origin = normalizeOrigin(env.SITE_URL) || 'https://braketa.top'
const dryRun = process.argv.includes('--dry-run')
const urls = await collectUrls({ env, origin })
console.log(`${urls.length} URLs for ${origin}:\n${urls.join('\n')}`)
if (!dryRun) console.log(await submitUrls({ origin, urls }))
