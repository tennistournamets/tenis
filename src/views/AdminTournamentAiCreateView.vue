<script setup>
// "Quick with AI": the organizer describes the tournament (text, file, picture or voice), the
// `create` task proposes a complete tournament — what the text says plus sensible choices for
// the rest — and asks at most three questions. Everything stays editable on one screen; one
// button creates the tournament with its participants (pending) and courts.
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import AppIcon from '../components/AppIcon.vue'
import AiTextSource from '../components/admin/AiTextSource.vue'
import ParticipantImportPreview from '../components/admin/ParticipantImportPreview.vue'
import { callAi } from '../lib/ai'
import { useAiFeature } from '../lib/aiFeatures'
import { entryShape, importRowProblem, rowsForShape } from '../lib/aiSchemas'
import { CREATE_VISIBILITY_MODES } from '../lib/access'
import { errorMessage } from '../lib/errorMessages'
import { feeUnitKey, feeUnitsFor, organizerContactError, pickRegistrationDraft, validateRegistrationForm } from '../lib/registrationRules'
import { getSportConfig, isIndividualFormat, isPointsFormat, pointsTargetOptions } from '../lib/sportConfig'
import { supabase } from '../lib/supabase'
import { createChoices, createTournamentFromForm, defaultCreateForm } from '../lib/tournamentCreate'
import { normalizeTournamentSlug } from '../lib/tournamentSlug'
import { track } from '../lib/analytics'
import { useAuthStore } from '../stores/auth'
import { useFeatureFlagsStore } from '../stores/featureFlags'

const { t, locale } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const flags = useFeatureFlagsStore()
const aiCreateOn = useAiFeature('create')
const aiVoiceOn = useAiFeature('voice')

const PARTICIPANTS_MAX = 128
const text = ref('')
const thinking = ref(false)
const creating = ref(false)
const error = ref('')
const proposal = ref(false)
const form = reactive({ ...defaultCreateForm(), courts: null })
// Keys the organizer changed by hand: a new AI answer never overwrites them.
const touched = reactive(new Set())
const suggested = reactive(new Set())
const questions = ref([])
const answers = ref([])
const otherAnswer = reactive({})
const participants = ref([])
const unparsed = ref([])
const remarks = ref([])
const notices = ref([])
const notify = ref(false)

const cfg = computed(() => getSportConfig(form.sport))
const points = computed(() => isPointsFormat(form.format))
const individual = computed(() => isIndividualFormat(form.format))
const choices = computed(() => createChoices(form))
const doubles = computed(() => choices.value.category === 'doubles')
const shape = computed(() => entryShape({ format: form.format, category: choices.value.category, doubles_pairing_mode: choices.value.pairingMode }))
const team = computed(() => cfg.value.scoringFamily === 'goals')
const feeUnits = computed(() => feeUnitsFor({ sport: form.sport, category: choices.value.category }))
const sportOptions = computed(() => (flags.enabledSports.length ? flags.enabledSports : ['tennis', 'padel']))
const busy = computed(() => thinking.value || creating.value)

function localToday() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function edit(key) {
  touched.add(key)
  suggested.delete(key)
}

async function propose() {
  if (busy.value) return
  error.value = ''
  if (!text.value.trim()) { error.value = t('ai.errors.empty'); return }
  thinking.value = true
  try {
    const { result } = await callAi('create', {
      input: text.value,
      context: {
        enabledSports: sportOptions.value,
        sport: form.sport,
        today: localToday(),
        weekday: new Intl.DateTimeFormat('en', { weekday: 'long' }).format(new Date()),
        locale: locale.value,
        answers: answers.value,
      },
    })
    if (!Object.keys(result.fields).length && !result.participants.entries.length) {
      error.value = t('ai.create.nothing')
      return
    }
    apply(result)
  } catch (err) {
    error.value = errorMessage(err, t, 'ai.errors.unavailable')
  } finally {
    thinking.value = false
  }
}

function apply(result) {
  const fields = result.fields
  // Sport first: the format and the rules below depend on it.
  const keys = Object.keys(fields).sort((a, b) => (a === 'sport' ? -1 : b === 'sport' ? 1 : 0))
  for (const key of keys) {
    if (touched.has(key)) continue
    form[key] = fields[key]
  }
  if (!form.name) form.name = ''
  suggested.clear()
  for (const key of result.suggested) if (!touched.has(key)) suggested.add(key)
  if (!touched.has('participants')) {
    participants.value = result.participants.entries.map((entry, index) => ({ ...entry, key: `p${index}-${Date.now()}`, error: '' }))
    unparsed.value = result.participants.unparsed
  }
  questions.value = result.questions
  remarks.value = result.remarks
  notices.value = result.notices
  proposal.value = true
}

function answer(question, value) {
  const reply = String(value ?? '').trim()
  if (!reply) return
  answers.value = [...answers.value.filter(item => item.question !== question), { question, answer: reply }]
  questions.value = questions.value.filter(item => item.question !== question)
  otherAnswer[question] = ''
  // Answers go back with the text; the AI refines the proposal and may ask what is left.
  if (!questions.value.length) propose()
}

function restart() {
  Object.assign(form, { ...defaultCreateForm(), courts: null })
  touched.clear()
  suggested.clear()
  for (const ref_ of [questions, answers, participants, unparsed, remarks, notices]) ref_.value = []
  proposal.value = false
  error.value = ''
}

// The format must fit the sport; the points target must fit the format.
function setSport(value) {
  form.sport = value
  edit('sport')
  if (!getSportConfig(value).allowedFormats.includes(form.format)) form.format = getSportConfig(value).allowedFormats[0]
  fitPoints()
}
function setFormat(value) {
  form.format = value
  edit('format')
  fitPoints()
}
function fitPoints() {
  if (isPointsFormat(form.format) && !pointsTargetOptions(form.format).includes(Number(form.points_per_match))) {
    form.points_per_match = pointsTargetOptions(form.format).includes(24) ? 24 : 21
  }
}

async function create() {
  if (busy.value) return
  error.value = ''
  if (!String(form.name).trim()) { error.value = t('admin.wizardNameRequired'); return }
  const contactError = organizerContactError(form.contact_phone, form.contact_email)
  if (contactError) { error.value = t(contactError); return }
  const regError = validateRegistrationForm(pickRegistrationDraft(form))
  if (regError) { error.value = t(regError); return }
  const rows = rowsForShape(participants.value, shape.value)
  if (rows.length > PARTICIPANTS_MAX) { error.value = t('ai.import.tooMany'); return }
  const problems = rows.map(row => importRowProblem(row, { shape: shape.value, team: team.value }))
  if (problems.some(Boolean)) {
    participants.value = rows.map((row, index) => ({ ...row, error: problems[index] ? t(problems[index]) : '' }))
    error.value = t('ai.create.participantsInvalid', { n: problems.filter(Boolean).length })
    return
  }

  creating.value = true
  const base = normalizeTournamentSlug(form.name) || `tournament-${crypto.randomUUID().slice(0, 8)}`
  const courtNames = Array.from({ length: Number(form.courts) || 0 }, (_, index) => t('ai.create.courtName', { n: index + 1 }))
  try {
    let result = null
    // A taken address gets a number: the organizer did not choose it here.
    for (let attempt = 1; !result; attempt++) {
      const slug = attempt === 1 ? base : `${base.slice(0, 74)}-${attempt}`
      try {
        result = await createTournamentFromForm(supabase, form, { slug, participants: rows, notify: notify.value, courtNames })
      } catch (err) {
        if (err?.code !== '23505' || attempt >= 5) throw err
      }
    }
    track('tournament_created', { sport: form.sport, format: form.format, category: choices.value.category, visibility: form.visibility, via: 'ai' })
    const query = {}
    if (form.visibility !== 'private') query.created = '1'
    if (result.rulesFailed) query.regfail = '1'
    if (result.participantsFailed) query.aifail = String(result.participantsFailed)
    await router.replace({ name: 'admin-tournament', params: { id: result.id }, query: Object.keys(query).length ? query : undefined })
  } catch (err) {
    error.value = errorMessage(err, t, 'mobile.createFailed')
  } finally {
    creating.value = false
  }
}

onMounted(async () => {
  await Promise.all([auth.init(), flags.load().catch(() => {})])
  // Switched off by the super-admin: the manual wizard is the way in.
  if (!aiCreateOn()) router.replace({ name: 'admin-tournament-new' })
})
</script>

<template>
  <div class="quick stack">
    <div>
      <RouterLink class="admin-back-link" :to="{ name: 'admin-tournaments' }">{{ t('admin.backToList') }}</RouterLink>
      <h1 class="page-title quick__title">
        <AppIcon name="sparkles" :size="26" />
        {{ t('ai.create.title') }}
      </h1>
      <p class="muted quick__lead">{{ t('ai.create.lead') }}</p>
    </div>

    <section class="card stack stack--sm">
      <AiTextSource
        id="quick-text"
        v-model="text"
        :label="t('ai.create.label')"
        :placeholder="t('ai.create.placeholder')"
        :rows="5"
        :disabled="busy"
        :voice="aiVoiceOn()"
      />
      <div class="quick__actions">
        <button type="button" class="btn btn--primary" :disabled="busy || !text.trim()" @click="propose">
          {{ thinking ? t('ai.create.proposing') : proposal ? t('ai.create.update') : t('ai.create.propose') }}
        </button>
        <button v-if="proposal" type="button" class="btn btn--ghost" :disabled="busy" @click="restart">{{ t('ai.create.restart') }}</button>
      </div>
      <p v-if="error && !proposal" class="alert alert--error" role="alert">{{ error }}</p>
    </section>

    <template v-if="proposal">
      <section v-if="questions.length" class="card stack stack--sm quick__questions" aria-labelledby="quick-questions">
        <h2 id="quick-questions" class="section-title">{{ t('ai.create.questionsTitle') }}</h2>
        <div v-for="item in questions" :key="item.question" class="quick__question">
          <p class="quick__question-text">{{ item.question }}</p>
          <div class="quick__chips">
            <button v-for="option in item.options" :key="option" type="button" class="quick__chip" :disabled="busy" @click="answer(item.question, option)">
              {{ option }}
            </button>
            <form class="quick__other" @submit.prevent="answer(item.question, otherAnswer[item.question])">
              <input v-model="otherAnswer[item.question]" class="input input--sm" type="text" maxlength="200" :placeholder="t('ai.create.other')" :aria-label="`${item.question} — ${t('ai.create.other')}`" :disabled="busy" />
            </form>
          </div>
        </div>
        <button type="button" class="btn btn--outline btn--sm quick__apply" :disabled="busy || !answers.length" @click="propose">
          {{ thinking ? t('ai.create.proposing') : t('ai.create.applyAnswers') }}
        </button>
      </section>

      <section class="card stack quick__proposal" :aria-busy="thinking">
        <div class="quick__head">
          <div class="form-field quick__name">
            <label for="quick-name">{{ t('admin.name') }}</label>
            <input id="quick-name" v-model="form.name" class="input input--lg" type="text" maxlength="100" @input="edit('name')" />
          </div>
          <p class="quick__legend"><span class="quick__ai">✦ {{ t('ai.create.badge') }}</span> {{ t('ai.create.legend') }}</p>
        </div>

        <ul v-if="notices.length || remarks.length" class="quick__notes">
          <li v-for="code in notices" :key="code">{{ t(`ai.create.notices.${code}`) }}</li>
          <li v-for="(line, index) in remarks" :key="`r${index}`">{{ line }}</li>
        </ul>

        <fieldset class="quick__group">
          <legend>{{ t('ai.create.sections.tournament') }}</legend>
          <div class="quick__grid">
            <div class="form-field">
              <label for="quick-sport">{{ t('admin.wizardStepSport') }} <span v-if="suggested.has('sport')" class="quick__ai">✦ {{ t('ai.create.badge') }}</span></label>
              <select id="quick-sport" :value="form.sport" class="input" @change="setSport($event.target.value)">
                <option v-for="sport in sportOptions" :key="sport" :value="sport">{{ t('sport.' + sport) }}</option>
              </select>
            </div>
            <div class="form-field">
              <label for="quick-format">{{ t('admin.wizardStepFormat') }} <span v-if="suggested.has('format')" class="quick__ai">✦ {{ t('ai.create.badge') }}</span></label>
              <select id="quick-format" :value="form.format" class="input" @change="setFormat($event.target.value)">
                <option v-for="format in cfg.allowedFormats" :key="format" :value="format">{{ t('tournamentFormat.' + format) }}</option>
              </select>
            </div>
            <div v-if="cfg.supportsCategory && !individual" class="form-field">
              <label for="quick-category">{{ t('admin.category') }} <span v-if="suggested.has('category')" class="quick__ai">✦ {{ t('ai.create.badge') }}</span></label>
              <select id="quick-category" v-model="form.category" class="input" @change="edit('category')">
                <option value="singles">{{ t('tournament.singles') }}</option>
                <option value="doubles">{{ t('tournament.doubles') }}</option>
              </select>
            </div>
            <div class="form-field">
              <label for="quick-gender">{{ t('admin.divisionLabel') }} <span v-if="suggested.has('gender')" class="quick__ai">✦ {{ t('ai.create.badge') }}</span></label>
              <select id="quick-gender" v-model="form.gender" class="input" @change="edit('gender')">
                <option value="men">{{ t('admin.genderMen') }}</option>
                <option value="women">{{ t('admin.genderWomen') }}</option>
                <option v-if="doubles && !individual" value="mixed">{{ t('admin.genderMixed') }}</option>
              </select>
            </div>
            <div v-if="points" class="form-field">
              <label for="quick-points">{{ t('pointsFormat.targetLabel') }} <span v-if="suggested.has('points_per_match')" class="quick__ai">✦ {{ t('ai.create.badge') }}</span></label>
              <select id="quick-points" v-model.number="form.points_per_match" class="input" @change="edit('points_per_match')">
                <option v-for="n in pointsTargetOptions(form.format)" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <div v-if="cfg.supportsSetFormat && !points" class="form-field">
              <label for="quick-sets">{{ t('admin.setFormat') }} <span v-if="suggested.has('set_format')" class="quick__ai">✦ {{ t('ai.create.badge') }}</span></label>
              <select id="quick-sets" v-model="form.set_format" class="input" @change="edit('set_format')">
                <option value="best_of_3">{{ t('format.best_of_3') }}</option>
                <option value="best_of_5">{{ t('format.best_of_5') }}</option>
              </select>
            </div>
            <div v-if="form.sport === 'padel' && !points" class="form-field">
              <label for="quick-tiebreak">{{ t('admin.tiebreakTo') }}</label>
              <select id="quick-tiebreak" v-model.number="form.tiebreak_to" class="input" @change="edit('tiebreak_to')">
                <option :value="7">{{ t('admin.tiebreakTo7') }}</option>
                <option :value="10">{{ t('admin.tiebreakTo10') }}</option>
              </select>
            </div>
            <div v-if="form.format === 'groups_playoff'" class="form-field">
              <label for="quick-advance">{{ t('groupsFlow.advance') }}</label>
              <select id="quick-advance" v-model.number="form.advance_per_group" class="input" @change="edit('advance_per_group')">
                <option v-for="n in [1, 2, 3, 4]" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
          </div>
          <label v-if="doubles && !individual && cfg.supportsDoublesPairing" class="checkbox-row">
            <input v-model="form.doubles_pairing_random" type="checkbox" @change="edit('doubles_pairing_random')" />
            {{ t('admin.pickRandomPairs') }}
          </label>
        </fieldset>

        <fieldset class="quick__group">
          <legend>{{ t('ai.create.sections.place') }}</legend>
          <div class="quick__grid">
            <div class="form-field quick__wide">
              <label for="quick-description">{{ t('admin.description') }}</label>
              <textarea id="quick-description" v-model="form.description" class="input" rows="2" @input="edit('description')"></textarea>
            </div>
            <div class="form-field">
              <label for="quick-venue">{{ t('venue.section') }}</label>
              <input id="quick-venue" v-model="form.venue_address" class="input" type="text" maxlength="200" @input="edit('venue_address')" />
            </div>
            <div class="form-field">
              <label for="quick-courts">{{ t('ai.create.courts') }} <span v-if="suggested.has('courts')" class="quick__ai">✦ {{ t('ai.create.badge') }}</span></label>
              <input id="quick-courts" v-model.number="form.courts" class="input" type="number" min="0" max="20" inputmode="numeric" @input="edit('courts')" />
            </div>
          </div>
        </fieldset>

        <fieldset class="quick__group">
          <legend>{{ t('ai.create.sections.registration') }}</legend>
          <div class="quick__grid">
            <div class="form-field">
              <label for="quick-capacity">{{ t('registrationRules.capacity') }} <span v-if="suggested.has('registration_capacity')" class="quick__ai">✦ {{ t('ai.create.badge') }}</span></label>
              <input id="quick-capacity" v-model="form.registration_capacity" class="input" type="number" min="2" max="512" inputmode="numeric" @input="edit('registration_capacity')" />
            </div>
            <div class="form-field">
              <label for="quick-deadline">{{ t('registrationRules.deadlineField') }}</label>
              <input id="quick-deadline" v-model="form.registration_deadline" class="input" type="datetime-local" @input="edit('registration_deadline')" />
            </div>
            <div class="form-field">
              <label for="quick-fee-mode">{{ t('registrationRules.feeMode') }}</label>
              <select id="quick-fee-mode" v-model="form.entry_fee_mode" class="input" @change="edit('entry_fee_mode')">
                <option value="">{{ t('registrationRules.feeUnspecified') }}</option>
                <option value="free">{{ t('registrationRules.feeModeFree') }}</option>
                <option value="paid">{{ t('registrationRules.feeModePaid') }}</option>
              </select>
            </div>
            <template v-if="form.entry_fee_mode === 'paid'">
              <div class="form-field">
                <label for="quick-fee-amount">{{ t('registrationRules.feeAmount') }} ({{ form.entry_fee_currency }})</label>
                <input id="quick-fee-amount" v-model="form.entry_fee_amount" class="input" type="text" inputmode="decimal" @input="edit('entry_fee_amount')" />
              </div>
              <div class="form-field">
                <label for="quick-fee-unit">{{ t('registrationRules.feeUnit') }}</label>
                <select id="quick-fee-unit" v-model="form.entry_fee_unit" class="input" @change="edit('entry_fee_unit')">
                  <option v-for="unit in feeUnits" :key="unit" :value="unit">{{ t(feeUnitKey(unit)) }}</option>
                </select>
              </div>
            </template>
          </div>
          <label v-if="form.registration_capacity" class="checkbox-row">
            <input v-model="form.waitlist_enabled" type="checkbox" @change="edit('waitlist_enabled')" />
            {{ t('registrationRules.waitlistSetting') }}
          </label>
        </fieldset>

        <fieldset class="quick__group">
          <legend>{{ t('ai.create.sections.publish') }}</legend>
          <div class="quick__grid">
            <div class="form-field">
              <label for="quick-visibility">{{ t('ai.create.visibility') }}</label>
              <select id="quick-visibility" v-model="form.visibility" class="input" @change="edit('visibility')">
                <option v-for="mode in CREATE_VISIBILITY_MODES" :key="mode" :value="mode">{{ t(`access.visibility.${mode}`) }}</option>
              </select>
            </div>
            <div class="form-field">
              <label for="quick-phone">{{ t('admin.contactPhone') }}</label>
              <input id="quick-phone" v-model="form.contact_phone" class="input" type="tel" autocomplete="tel" @input="edit('contact_phone')" />
            </div>
            <div class="form-field">
              <label for="quick-email">{{ t('admin.contactEmail') }}</label>
              <input id="quick-email" v-model="form.contact_email" class="input" type="email" autocomplete="email" @input="edit('contact_email')" />
            </div>
          </div>
        </fieldset>

        <fieldset v-if="participants.length" class="quick__group">
          <legend>{{ t('ai.create.participantsTitle', { n: participants.length }) }}</legend>
          <p class="field-hint">{{ t('ai.create.participantsHint') }}</p>
          <ParticipantImportPreview v-model="participants" :shape="shape" :team="team" :disabled="busy" @update:model-value="touched.add('participants')" />
          <ul v-if="unparsed.length" class="quick__notes">
            <li v-for="(line, index) in unparsed" :key="`u${index}`">{{ t('ai.create.unparsed', { line }) }}</li>
          </ul>
          <div class="quick__actions">
            <label class="checkbox-row" for="quick-notify">
              <input id="quick-notify" v-model="notify" type="checkbox" />
              <span>{{ t('ai.import.notify') }} <span class="field-hint">{{ t('ai.import.notifyHint') }}</span></span>
            </label>
            <button type="button" class="btn btn--ghost btn--sm" :disabled="busy" @click="participants = []; touched.add('participants')">{{ t('ai.create.removeList') }}</button>
          </div>
        </fieldset>

        <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
        <div class="quick__footer">
          <button type="button" class="btn btn--primary btn--lg" :disabled="busy" @click="create">
            {{ creating ? t('ai.create.creating') : t('ai.create.create') }}
          </button>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.quick {
  max-width: 880px;
}
.quick__title {
  display: flex;
  align-items: center;
  gap: 10px;
}
.quick__title .app-icon {
  color: var(--primary);
}
.quick__lead {
  margin: 0;
  max-width: 68ch;
}
.quick__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
}
.quick__questions {
  border-color: var(--primary);
}
.quick__question {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.quick__question-text {
  margin: 0;
  font-weight: 600;
}
.quick__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.quick__chip {
  min-height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--border-strong, var(--border));
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.quick__chip:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-soft);
}
.quick__chip:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.quick__other .input {
  min-height: 36px;
  width: 11rem;
}
.quick__apply {
  align-self: flex-start;
}
.quick__head {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.quick__name {
  margin: 0;
}
.quick__legend {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--muted);
}
.quick__ai {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  color: var(--primary);
  background: var(--primary-soft);
  vertical-align: middle;
}
.quick__notes {
  margin: 0;
  padding: 10px 14px 10px 30px;
  border-radius: var(--radius-sm, 10px);
  background: var(--surface-row);
  font-size: 0.875rem;
  color: var(--muted);
}
.quick__group {
  margin: 0;
  padding: 0;
  border: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
}
.quick__group legend {
  padding: 0;
  margin-bottom: 6px;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.quick__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--space-3, 12px);
}
.quick__grid .form-field {
  margin: 0;
}
.quick__wide {
  grid-column: 1 / -1;
}
.quick__footer {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-3, 12px);
  border-top: 1px solid var(--border);
}
@media (max-width: 560px) {
  .quick__footer .btn {
    width: 100%;
  }
}
</style>
