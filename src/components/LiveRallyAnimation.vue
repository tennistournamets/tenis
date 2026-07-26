<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { normalizeTennisState } from '../lib/useTennisScoring'

const props = defineProps({
  state: {
    type: Object,
    default: null,
  },
  teamA: {
    type: String,
    required: true,
  },
  teamB: {
    type: String,
    required: true,
  },
  swapped: {
    type: Boolean,
    default: false,
  },
})

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

const norm = computed(() => normalizeTennisState(props.state))

const pointCelebrant = ref(null)
let celebrationTimer = null

const burst = ref(null)
let burstTimer = null

const BURST_COLORS = ['var(--success)', '#d8e153', '#8fd9b0', 'var(--muted)']
const BURST_PARTICLES = Array.from({ length: 12 }, (_, i) => {
  const angle = (Math.PI * 2 * i) / 12 - Math.PI / 2
  const dist = 12 + (i % 3) * 4
  return {
    dx: Math.round(Math.cos(angle) * dist),
    dy: Math.round(Math.sin(angle) * dist * 0.9) - 4,
    r: 1.6 + (i % 3) * 0.5,
    color: BURST_COLORS[i % BURST_COLORS.length],
    delay: (i % 4) * 40,
  }
})

// Three little fireworks popping one after another above the winner's head.
const BURST_CLUSTERS = [
  { dx: -12, dy: 2, delay: 0, scale: 0.85 },
  { dx: 12, dy: -4, delay: 550, scale: 1 },
  { dx: 0, dy: 3, delay: 1100, scale: 1.2 },
]

// 'set' / 'game' wins get a firework burst on top of the point celebration.
function detectPointWin(prev, next) {
  const levels = [
    ['setsWon', 'set'],
    ['games', 'game'],
    ['tiebreakPoints', 'point'],
    ['points', 'point'],
  ]
  for (const [key, level] of levels) {
    for (const side of ['a', 'b']) {
      if (next[key][side] > prev[key][side]) return { side, level }
    }
  }
  return null
}

function fireBurst(side) {
  burst.value = { side, key: (burst.value?.key || 0) + 1 }
  if (burstTimer) clearTimeout(burstTimer)
  burstTimer = setTimeout(() => {
    burst.value = null
    burstTimer = null
  }, 2200)
}

watch(norm, (next, prev) => {
  if (!prev) return
  const win = detectPointWin(prev, next)
  if (!win) return
  pointCelebrant.value = win.side
  if (celebrationTimer) clearTimeout(celebrationTimer)
  // Game/set wins celebrate through the triple burst AND the side-change
  // glide (starts at CHANGEOVER_DELAY_MS, runs 0.9s) — ball stays hidden.
  celebrationTimer = setTimeout(() => {
    pointCelebrant.value = null
    celebrationTimer = null
  }, win.level === 'point' ? 2000 : 4200)
  if (win.level !== 'point' && !reducedMotion) {
    fireBurst(win.side)
  }
})

onBeforeUnmount(() => {
  if (celebrationTimer) clearTimeout(celebrationTimer)
  if (burstTimer) clearTimeout(burstTimer)
})

const celebrant = computed(() => norm.value.winner || pointCelebrant.value)
const isCelebrating = computed(() => Boolean(celebrant.value))

// Logical sides in display order: [left slot, right slot].
const sides = computed(() => (props.swapped ? ['b', 'a'] : ['a', 'b']))

// Players are drawn at full size and scaled down at the slot transform so the
// figures stay small relative to the court (feet anchored at the ground line).
// Transforms live in style (not the SVG attribute) so a CSS transition can
// glide the figures across the court on changeover; scaleX flips through 0,
// reading as the player turning around mid-walk.
const PLAYER_SCALE = 0.75

const playerSlots = computed(() => [
  { side: sides.value[0], css: `translate(20px, 132px) scale(${PLAYER_SCALE})`, begin: '0s' },
  { side: sides.value[1], css: `translate(340px, 132px) scale(${-PLAYER_SCALE}, ${PLAYER_SCALE})`, begin: '-1.7s' },
])

function teamName(side) {
  return side === 'a' ? props.teamA : props.teamB
}

const burstX = computed(() => (burst.value?.side === sides.value[0] ? 20 : 340))
</script>

<template>
  <div class="rally" :class="{ 'rally--celebrating': isCelebrating }">
    <svg class="rally__scene" viewBox="0 50 360 82" aria-hidden="true">
      <!-- ground -->
      <line class="rally__ground" x1="14" y1="132" x2="346" y2="132" />
      <!-- net -->
      <rect class="rally__net" x="178.4" y="96" width="3.2" height="36" rx="1.6" />
      <line class="rally__net-band" x1="173" y1="97.5" x2="187" y2="97.5" />

      <!-- players: left slot upright, right slot mirrored -->
      <g v-for="slot in playerSlots" :key="slot.side" class="player-slot" :style="{ transform: slot.css }">
        <g class="player" :class="{ 'player--win': celebrant === slot.side }">
          <circle class="player__head" cx="2" cy="-52" r="7.5" />
          <line x1="0" y1="-44" x2="0" y2="-20" />
          <line x1="0" y1="-20" x2="-7" y2="0" />
          <line x1="0" y1="-20" x2="6" y2="0" />
          <line x1="0" y1="-40" x2="-8" y2="-28" />
          <g class="player__arm player__arm--swing">
            <line x1="0" y1="-40" x2="12" y2="-32" />
            <line x1="12" y1="-32" x2="17" y2="-35" />
            <ellipse class="player__racket" cx="21" cy="-38" rx="4.5" ry="7" transform="rotate(-40 21 -38)" />
            <animateTransform
              v-if="!reducedMotion"
              attributeName="transform"
              type="rotate"
              values="-55 0 -40; 5 0 -40; 25 0 -40; -55 0 -40"
              keyTimes="0;0.25;0.8;1"
              :begin="slot.begin"
              dur="3.4s"
              repeatCount="indefinite"
            />
          </g>
          <g class="player__arm player__arm--raised">
            <line x1="0" y1="-40" x2="8" y2="-54" />
            <line x1="8" y1="-54" x2="11" y2="-60" />
            <ellipse class="player__racket" cx="13" cy="-66" rx="4.5" ry="7" transform="rotate(15 13 -66)" />
          </g>
        </g>
      </g>

      <!-- game/set win: three staggered fireworks above the winner's head -->
      <g v-if="burst" :key="burst.key" class="burst">
        <g
          v-for="(c, ci) in BURST_CLUSTERS"
          :key="ci"
          :transform="`translate(${burstX + c.dx}, ${72 + c.dy}) scale(${c.scale})`"
        >
          <circle
            v-for="(p, i) in BURST_PARTICLES"
            :key="i"
            class="burst__p"
            cx="0"
            cy="0"
            :r="p.r"
            :style="{ '--dx': p.dx + 'px', '--dy': p.dy + 'px', fill: p.color, animationDelay: (p.delay + c.delay) + 'ms' }"
          />
        </g>
      </g>

      <!-- ball -->
      <g v-if="!reducedMotion" class="rally__ball-x">
        <g class="rally__ball-y">
          <circle class="rally__ball" cx="0" cy="0" r="4.5" />
          <!-- Tennis trajectory: racket hit → arc over the net → bounce off the
               ground line → short hop up to the opponent's racket. -->
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 102; 0 58; 0 127; 0 102; 0 58; 0 127; 0 102"
            keyTimes="0;0.2;0.4;0.5;0.7;0.9;1"
            calcMode="spline"
            keySplines=".17 .67 .5 1; .5 0 .83 .33; .17 .67 .5 1; .17 .67 .5 1; .5 0 .83 .33; .17 .67 .5 1"
            dur="3.4s"
            repeatCount="indefinite"
          />
        </g>
        <animateTransform
          attributeName="transform"
          type="translate"
          values="36 0; 324 0; 36 0"
          keyTimes="0;0.5;1"
          dur="3.4s"
          repeatCount="indefinite"
        />
      </g>
    </svg>

    <TransitionGroup name="side-swap" tag="div" class="rally__names">
      <span
        v-for="side in sides"
        :key="side"
        class="rally__name"
        :class="{ 'rally__name--win': celebrant === side }"
      >{{ teamName(side) }}</span>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.rally {
  padding: var(--space-2) 0 0;
}

.rally__scene {
  display: block;
  width: 100%;
  height: auto;
}

.rally__ground {
  stroke: var(--border);
  stroke-width: 2;
  stroke-linecap: round;
}

.rally__net {
  fill: var(--border);
}

.rally__net-band {
  stroke: var(--muted);
  stroke-width: 2.5;
  stroke-linecap: round;
}

.player-slot {
  transition: transform 0.9s cubic-bezier(0.45, 0, 0.25, 1);
}

.side-swap-move {
  transition: transform 0.9s cubic-bezier(0.45, 0, 0.25, 1);
}

.player {
  color: var(--text);
  transition: filter 0.25s;
}

.player line {
  stroke: currentColor;
  stroke-width: 3.5;
  stroke-linecap: round;
}

.player__head {
  fill: currentColor;
}

.player__racket {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
}

.player__arm--raised {
  display: none;
}

.player--win {
  color: var(--success);
  filter: drop-shadow(0 0 6px var(--success-border));
  animation: rally-hop 0.5s ease;
}

.player--win .player__arm--swing {
  display: none;
}

.player--win .player__arm--raised {
  display: block;
}

@keyframes rally-hop {
  0%, 100% { transform: translateY(0); }
  40% { transform: translateY(-9px); }
}

.burst__p {
  opacity: 0;
  animation: rally-burst 0.8s ease-out forwards;
}

@keyframes rally-burst {
  0% {
    transform: translate(0, 0) scale(1);
    opacity: 1;
  }
  100% {
    transform: translate(var(--dx), var(--dy)) scale(0.3);
    opacity: 0;
  }
}

.rally__ball {
  fill: #d8e153;
  stroke: rgba(255, 255, 255, 0.4);
  stroke-width: 1;
}

.rally__ball-x {
  transition: opacity 0.2s;
}

.rally--celebrating .rally__ball-x {
  opacity: 0;
}

.rally__names {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-top: 2px;
}

.rally__name {
  min-width: 0;
  text-align: center;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.25s;
}

.rally__name--win {
  color: var(--success-text);
}

@media (prefers-reduced-motion: reduce) {
  .player--win {
    animation: none;
  }

  .player-slot,
  .side-swap-move {
    transition: none;
  }
}
</style>
