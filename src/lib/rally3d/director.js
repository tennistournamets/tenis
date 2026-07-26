import * as THREE from 'three'

import { makeBlobShadowTexture } from './scene'
import { KITS, createPlayer } from './player'
import {
  PoseBlender,
  clipCelebrate,
  clipDejected,
  clipMove,
  clipReady,
  clipSplitStep,
  clipStroke,
  clipWalk,
  headTrack,
} from './strokes'

const HALF = 1.7 // seconds per net crossing
const STROKE_PRE = 0.55 // unit turn starts this long before own contact
const STROKE_POST = 0.45 // follow-through after contact
const STROKE_DUR = STROKE_PRE + STROKE_POST
const SPLIT_LEAD = 0.14 // split step lands as the opponent strikes
const SPLIT_DUR = 0.36

const CONTACT_X = 11.6 // rally contact around the baseline
const HOME_X = 12.2
const CONTACT_Y = 1.15
const BALL_R = 0.13
const BOUNCE_S = 0.72
const SWAP_DUR = 1.6
const PLAYER_SCALE = 1.12
const REACH = 0.72 // stand this far to the side of the contact point
const MAX_SPEED = 6.5 // m/s lateral coverage

// Cross-court / down-the-line mix, full singles width coverage.
const Z_TARGETS = [2.9, -2.5, 0.7, -3.1, 1.9, 3.1, -1.2, -2.8, 2.3, -0.3, 3.0, -1.9]

function lerp(a, b, t) {
  return a + (b - a) * t
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function smooth(t) {
  const v = clamp(t, 0, 1)
  return v * v * (3 - 2 * v)
}

function arcY(y0, y1, height, u) {
  return lerp(y0, y1, u) + height * 4 * u * (1 - u)
}

export class RallyDirector {
  constructor(scene, { swapped = false } = {}) {
    this.scene = scene
    this.time = 0
    this.rallyClock = HALF * 0.5 // start mid-flight, both players in ready
    this.mode = 'rally'
    this.celebration = null
    this.swap = null
    this.plan = new Map() // contact index -> { type, standZ }

    // players[0] = side A, players[1] = side B
    this.players = [KITS.a, KITS.b].map((kit, i) => {
      const rig = createPlayer(kit)
      rig.group.scale.setScalar(PLAYER_SCALE)
      scene.add(rig.group)
      return {
        rig,
        blender: new PoseBlender(rig),
        z: 0,
        vz: 0,
        yawOffset: 0,
        idlePhase: i * 1.7,
      }
    })
    this.endSigns = [swapped ? 1 : -1, swapped ? -1 : 1]
    for (let i = 0; i < 2; i += 1) {
      const end = this.endSigns[i]
      this.players[i].rig.group.position.set(end * HOME_X, 0, 0)
      this.players[i].rig.group.rotation.y = this.facingYaw(end)
    }

    const ballMat = new THREE.MeshStandardMaterial({ color: 0xd8e153, roughness: 0.45 })
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 18, 14), ballMat)
    scene.add(this.ball)

    this.ballShadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeBlobShadowTexture(),
        transparent: true,
        depthWrite: false,
      }),
    )
    this.ballShadow.rotation.x = -Math.PI / 2
    this.ballShadow.position.y = 0.012
    scene.add(this.ballShadow)
  }

  contactZ(k) {
    return Z_TARGETS[((k % Z_TARGETS.length) + Z_TARGETS.length) % Z_TARGETS.length]
  }

  hitterEnd(k) {
    return k % 2 === 0 ? -1 : 1
  }

  facingYaw(end) {
    return end === -1 ? Math.PI / 2 : -Math.PI / 2
  }

  // Racket reach direction in world Z. Right-handers: forehand side is -Z at
  // the -X end and +Z at the +X end.
  reachSign(end, type) {
    const forehandSign = end === -1 ? -1 : 1
    return type === 'backhand' ? -forehandSign : forehandSign
  }

  // Decide (once) how a contact will be played, based on where the player is
  // coming from — approach from the forehand side gives a forehand.
  planFor(k, playerZ) {
    let entry = this.plan.get(k)
    if (!entry) {
      const end = this.hitterEnd(k)
      const z = this.contactZ(k)
      const forehandSign = end === -1 ? -1 : 1
      const dz = z - playerZ
      const type = Math.sign(dz || 1) === forehandSign ? 'forehand' : 'backhand'
      entry = { type, standZ: z - this.reachSign(end, type) * REACH }
      this.plan.set(k, entry)
      if (this.plan.size > 12) {
        for (const key of this.plan.keys()) {
          if (key < k - 4) this.plan.delete(key)
        }
      }
    }
    return entry
  }

  celebrate(side, level) {
    const index = side === 'a' ? 0 : 1
    this.celebration = {
      index,
      level,
      until: this.time + (level === 'point' ? 2.0 : 4.2),
    }
    if (this.mode === 'rally') this.mode = 'celebrate'
  }

  setWinner(side) {
    this.mode = 'celebrate'
    this.celebration = { index: side === 'a' ? 0 : 1, level: 'match', until: Infinity }
  }

  setSwapped(swapped, animate = true) {
    const desired = swapped ? 1 : -1
    if (this.endSigns[0] === desired) return
    this.endSigns = [desired, -desired]
    this.plan.clear()
    this.rallyClock = Math.ceil(this.rallyClock / HALF + 0.001) * HALF + HALF * 0.5

    if (!animate) {
      for (let i = 0; i < 2; i += 1) {
        const end = this.endSigns[i]
        this.players[i].rig.group.position.set(end * HOME_X, 0, 0)
        this.players[i].rig.group.rotation.y = this.facingYaw(end)
        this.players[i].z = 0
      }
      return
    }

    const from = this.players.map((p) => ({
      x: p.rig.group.position.x,
      z: p.rig.group.position.z,
    }))
    const to = this.players.map((p, i) => ({ x: this.endSigns[i] * HOME_X, z: 0 }))
    this.swap = { start: this.time, from, to }
    this.mode = 'swap'
  }

  update(dt) {
    this.time += dt

    if (this.mode === 'swap') {
      this.updateSwap(dt)
    } else if (this.mode === 'celebrate') {
      this.updateCelebrate(dt)
    } else {
      this.updateRally(dt)
    }
  }

  updateSwap(dt) {
    const p = clamp((this.time - this.swap.start) / SWAP_DUR, 0, 1)
    const eased = smooth(p)
    this.setBallVisible(false)

    for (let i = 0; i < 2; i += 1) {
      const player = this.players[i]
      const from = this.swap.from[i]
      const to = this.swap.to[i]
      const bow = Math.sin(Math.PI * eased) * 2.6 * (i === 0 ? 1 : -1)
      const x = lerp(from.x, to.x, eased)
      const z = lerp(from.z, to.z, eased) + bow
      const group = player.rig.group
      const vx = x - group.position.x
      const vz = z - group.position.z
      group.position.x = x
      group.position.z = z
      player.z = z

      player.blender.setState('walk')
      player.blender.apply(clipWalk(this.time + player.idlePhase, Math.sin(Math.PI * p)), dt)

      if (p < 0.96 && (Math.abs(vx) > 1e-4 || Math.abs(vz) > 1e-4)) {
        group.rotation.y = Math.atan2(vx, vz)
      } else {
        group.rotation.y = this.facingYaw(this.endSigns[i])
      }
    }

    if (p >= 1) {
      this.swap = null
      this.mode = this.celebration && this.time < this.celebration.until ? 'celebrate' : 'rally'
    }
  }

  updateCelebrate(dt) {
    this.setBallVisible(false)
    const { index } = this.celebration

    for (let i = 0; i < 2; i += 1) {
      const player = this.players[i]
      player.blender.setState(i === index ? 'celebrate' : 'dejected')
      player.blender.apply(
        i === index ? clipCelebrate(this.time) : clipDejected(this.time + player.idlePhase),
        dt,
      )
      player.rig.group.rotation.y = this.facingYaw(this.endSigns[i])
    }

    if (this.time >= this.celebration.until) {
      this.celebration = null
      this.rallyClock = Math.ceil(this.rallyClock / HALF + 0.001) * HALF + HALF * 0.5
      this.mode = 'rally'
    }
  }

  updateRally(dt) {
    this.rallyClock += dt
    const clock = this.rallyClock
    const k = Math.floor(clock / HALF)
    const s = clock / HALF - k
    const dir = k % 2 === 0 ? 1 : -1 // +1: ball flying towards +X

    // --- ball flight: hit -> bounce -> rise to the next contact ---
    const x = lerp(-dir * CONTACT_X, dir * CONTACT_X, s)
    const z = lerp(this.contactZ(k), this.contactZ(k + 1), smooth(s))
    let y
    if (s < BOUNCE_S) {
      y = arcY(CONTACT_Y, BALL_R, 1.5, s / BOUNCE_S)
    } else {
      y = arcY(BALL_R, CONTACT_Y, 0.4, (s - BOUNCE_S) / (1 - BOUNCE_S))
    }
    this.setBallVisible(true)
    this.ball.position.set(x, y, z)
    this.ball.rotation.z -= dir * dt * 14

    const drop = Math.min(1, y / 2.4)
    this.ballShadow.position.x = x
    this.ballShadow.position.z = z
    this.ballShadow.scale.setScalar(0.55 + drop * 0.5)
    this.ballShadow.material.opacity = 0.9 - drop * 0.55

    // --- player brains ---
    for (let i = 0; i < 2; i += 1) {
      this.updateRallyPlayer(this.players[i], this.endSigns[i], clock, k, dt)
    }
  }

  updateRallyPlayer(player, end, clock, k, dt) {
    // Own contacts happen every second half; find the next one.
    let kOwn = Math.ceil(clock / HALF)
    if (this.hitterEnd(kOwn) !== end) kOwn += 1
    const tOwn = kOwn * HALF
    const tOwnPrev = tOwn - 2 * HALF
    const tOpp = tOwn - HALF // opponent's contact between our own
    const group = player.rig.group
    const blender = player.blender

    // --- decide the current activity ---
    const prevPlan = this.plan.get(kOwn - 2)
    const inPrevStroke = clock < tOwnPrev + STROKE_POST && prevPlan
    const nextPlan = clock >= tOwn - STROKE_PRE - 1e-6 ? this.planFor(kOwn, player.z) : null
    const inSplit = !nextPlan && clock >= tOpp - SPLIT_LEAD && clock < tOpp - SPLIT_LEAD + SPLIT_DUR

    // --- movement target ---
    let targetZ
    if (nextPlan || inPrevStroke) {
      targetZ = (nextPlan || prevPlan).standZ
    } else if (clock < tOpp - SPLIT_LEAD) {
      // recover towards the center mark after the shot
      targetZ = player.z * 0.25
    } else {
      // opponent has struck: sprint to the interception point
      targetZ = this.planFor(kOwn, player.z).standZ
    }

    // critically-damped-ish chase with a speed cap
    const want = clamp((targetZ - player.z) * 5, -MAX_SPEED, MAX_SPEED)
    player.vz += (want - player.vz) * Math.min(1, dt * 9)
    if (nextPlan) player.vz *= Math.max(0, 1 - dt * 6) // plant the feet for the swing
    player.z += player.vz * dt

    group.position.x = end * HOME_X
    group.position.z = player.z

    const speed01 = Math.abs(player.vz) / MAX_SPEED
    const localVx = player.vz * end // velocity in the player's local X
    const far = Math.abs(targetZ - player.z) > 1.25

    // face the net; lean the run direction in only for long sprints
    let yawTarget = 0
    if (!nextPlan && !inPrevStroke && far && speed01 > 0.25) {
      yawTarget = Math.atan2(localVx, 2.2)
    }
    player.yawOffset += (yawTarget - player.yawOffset) * Math.min(1, dt * 7)
    group.rotation.y = this.facingYaw(end) + player.yawOffset

    // --- pose ---
    let trackWeight = 1
    if (nextPlan) {
      const phase = clamp((clock - (tOwn - STROKE_PRE)) / STROKE_DUR, 0, 1)
      blender.setState(`stroke-${kOwn}`)
      blender.apply(clipStroke(nextPlan.type, phase), dt)
      trackWeight = 0.55
    } else if (inPrevStroke) {
      const phase = clamp((clock - (tOwnPrev - STROKE_PRE)) / STROKE_DUR, 0, 1)
      blender.setState(`stroke-${kOwn - 2}`)
      blender.apply(clipStroke(prevPlan.type, phase), dt)
      trackWeight = 0.55
    } else if (inSplit) {
      const t01 = (clock - (tOpp - SPLIT_LEAD)) / SPLIT_DUR
      blender.setState(`split-${kOwn}`)
      blender.apply(clipSplitStep(t01), dt)
    } else if (speed01 > 0.12) {
      blender.setState('move')
      blender.apply(
        clipMove(this.time + player.idlePhase, speed01, far ? 1 : 0, Math.sign(localVx) || 1),
        dt,
      )
    } else {
      blender.setState('ready')
      blender.apply(clipReady(this.time + player.idlePhase), dt)
    }

    headTrack(blender, this.ball.position, dt, trackWeight)
  }

  setBallVisible(visible) {
    this.ball.visible = visible
    this.ballShadow.visible = visible
  }
}

// Static 3/4 camera: slightly off-axis like a broadcast end-corner view.
const CAM_AZ = Math.PI / 2 - 0.24
const CAM_EL = 0.36
const CAM_R = 20.5

export function updateCamera(camera) {
  camera.position.set(
    Math.cos(CAM_AZ) * Math.cos(CAM_EL) * CAM_R,
    Math.sin(CAM_EL) * CAM_R,
    Math.sin(CAM_AZ) * Math.cos(CAM_EL) * CAM_R,
  )
  camera.lookAt(0.6, 0.35, 0)
}
