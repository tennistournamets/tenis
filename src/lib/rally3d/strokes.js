import * as THREE from 'three'

// Pose-clip animation layer. A Pose is a plain map: joint name -> [x, y, z]
// euler radians, plus `rootY` (crouch/hop offset in local meters). Clips are
// functions returning a Pose; the PoseBlender cross-fades between clips so
// state changes never pop.

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smooth(v) {
  const t = clamp01(v)
  return t * t * (3 - 2 * t)
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

// Keyframe sampler with smoothstep easing between keys: [[t, value], ...]
function sample(track, t) {
  if (t <= track[0][0]) return track[0][1]
  for (let i = 1; i < track.length; i += 1) {
    if (t <= track[i][0]) {
      const [t0, v0] = track[i - 1]
      const [t1, v1] = track[i]
      return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0))
    }
  }
  return track[track.length - 1][1]
}

const JOINTS = [
  'pelvis', 'spine', 'chest', 'neck', 'head',
  'clavL', 'shL', 'elL', 'wrL',
  'clavR', 'shR', 'elR', 'wrR',
  'hipL', 'kneeL', 'ankL',
  'hipR', 'kneeR', 'ankR',
]

// Relaxed athletic base. Every clip starts from a copy of this so all poses
// share the same key set (safe blending).
const BASE = {
  rootY: -0.03,
  pelvis: [0, 0, 0],
  spine: [0.04, 0, 0],
  chest: [0.06, 0, 0],
  neck: [0, 0, 0],
  head: [-0.06, 0, 0],
  clavL: [0, 0, 0],
  shL: [0.05, 0, 0.32],
  elL: [-0.5, 0, 0],
  wrL: [0, 0, 0],
  clavR: [0, 0, 0],
  shR: [0.05, 0, -0.32],
  elR: [-0.55, 0, 0],
  wrR: [-0.25, 0, 0],
  hipL: [-0.16, 0, 0.03],
  kneeL: [0.3, 0, 0],
  ankL: [-0.1, 0, 0],
  hipR: [-0.16, 0, -0.03],
  kneeR: [0.3, 0, 0],
  ankR: [-0.1, 0, 0],
}

export function newPose() {
  const pose = { rootY: BASE.rootY }
  for (const j of JOINTS) pose[j] = BASE[j].slice()
  return pose
}

function mixPose(from, to, w, out) {
  out.rootY = lerp(from.rootY, to.rootY, w)
  for (const j of JOINTS) {
    const a = from[j]
    const b = to[j]
    const o = out[j]
    o[0] = lerp(a[0], b[0], w)
    o[1] = lerp(a[1], b[1], w)
    o[2] = lerp(a[2], b[2], w)
  }
  return out
}

function copyPose(from, out) {
  out.rootY = from.rootY
  for (const j of JOINTS) {
    out[j][0] = from[j][0]
    out[j][1] = from[j][1]
    out[j][2] = from[j][2]
  }
  return out
}

export function applyPose(rig, pose) {
  for (const j of JOINTS) {
    rig.joints[j].rotation.set(pose[j][0], pose[j][1], pose[j][2])
  }
  rig.group.position.y = pose.rootY * rig.group.scale.y
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

// Ready stance: crouched, both hands bring the racket to the center line,
// weight gently shifting side to side.
export function clipReady(time) {
  const p = newPose()
  const bob = Math.sin(time * 3.4)
  p.rootY = -0.075 + bob * 0.012
  p.kneeL[0] = 0.52
  p.kneeR[0] = 0.52
  p.hipL[0] = -0.3
  p.hipR[0] = -0.3
  p.ankL[0] = -0.18
  p.ankR[0] = -0.18
  p.chest[0] = 0.14
  p.pelvis[2] = Math.sin(time * 1.7) * 0.035 // weight shift
  // racket up front, left hand on the throat
  p.shR = [0.35, 0.35, -0.38]
  p.elR = [-1.5, 0.25, 0]
  p.wrR = [-0.45, 0, 0.1]
  p.shL = [0.4, -0.5, 0.42]
  p.elL = [-1.45, 0, 0]
  p.head[0] = -0.12
  return p
}

// Split step: load -> hop -> wide soft landing. t is 0..1.
export function clipSplitStep(t) {
  const p = newPose()
  p.rootY = sample([[0, -0.07], [0.22, -0.11], [0.5, 0.03], [0.72, -0.13], [1, -0.09]], t)
  const wide = sample([[0, 0.03], [0.5, 0.1], [0.72, 0.2], [1, 0.16]], t)
  const knee = sample([[0, 0.5], [0.22, 0.62], [0.5, 0.3], [0.72, 0.72], [1, 0.58]], t)
  p.hipL[2] = wide
  p.hipR[2] = -wide
  p.kneeL[0] = knee
  p.kneeR[0] = knee
  p.hipL[0] = -knee * 0.62
  p.hipR[0] = -knee * 0.62
  p.ankL[0] = -0.2
  p.ankR[0] = -0.2
  p.chest[0] = 0.16
  p.shR = [0.3, 0.3, -0.5]
  p.elR = [-1.4, 0.2, 0]
  p.wrR = [-0.45, 0, 0.1]
  p.shL = [0.3, -0.3, 0.55]
  p.elL = [-1.3, 0, 0]
  return p
}

// Locomotion: gait 0 = side shuffle (facing the net), 1 = run. lateralSign
// tells which way the shuffle leads (+1 = local +X).
export function clipMove(time, speed01, gait, lateralSign) {
  const p = newPose()
  const freq = 7 + speed01 * 4.5
  const phase = time * freq
  const s = Math.sin(phase)
  const run = smooth(gait)

  // --- run component (legs swing front-back) ---
  const swing = 0.28 + speed01 * 0.55
  const hipLRun = s * swing
  const hipRRun = -s * swing
  const kneeLRun = 0.3 + Math.max(0, -s) * (0.7 + speed01 * 0.7)
  const kneeRRun = 0.3 + Math.max(0, s) * (0.7 + speed01 * 0.7)

  // --- shuffle component (legs open sideways alternately) ---
  const push = 0.16 + speed01 * 0.3
  const hipLShf = Math.max(0, s * lateralSign) * push * lateralSign
  const hipRShf = -Math.max(0, -s * lateralSign) * push * lateralSign

  p.hipL[0] = lerp(-0.24, hipLRun, run) - (1 - run) * 0.1
  p.hipR[0] = lerp(-0.24, hipRRun, run) - (1 - run) * 0.1
  p.hipL[2] = lerp(hipLShf + 0.06, 0.03, run)
  p.hipR[2] = lerp(hipRShf - 0.06, -0.03, run)
  p.kneeL[0] = lerp(0.48 + Math.max(0, -s) * 0.3, kneeLRun, run)
  p.kneeR[0] = lerp(0.48 + Math.max(0, s) * 0.3, kneeRRun, run)
  p.ankL[0] = -0.15
  p.ankR[0] = -0.15

  p.rootY = -0.07 + Math.abs(Math.sin(phase)) * (0.02 + speed01 * 0.035) * (0.4 + run * 0.6)
  p.chest[0] = 0.12 + run * speed01 * 0.24 // lean into the run
  p.spine[0] = 0.05 + run * speed01 * 0.1

  // arms: left pumps with the legs, right keeps the racket half-raised
  p.shL = [-s * (0.25 + run * speed01 * 0.45), 0, 0.36]
  p.elL = [-0.9, 0, 0]
  p.shR = [0.25 + s * run * 0.15, 0.25, -0.55]
  p.elR = [-1.25, 0.15, 0]
  p.wrR = [-0.4, 0, 0.1]
  return p
}

// ---------------------------------------------------------------------------
// Strokes: 1.0s clip, contact at t = 0.55. Kinetic chain per biomechanics:
// unit turn (hips+shoulders together) -> racket loop drop -> hips lead the
// drive, trunk follows, shoulder whips with wrist lag -> contact in front ->
// long decelerating follow-through over the opposite shoulder.
// ---------------------------------------------------------------------------

const FH = {
  pelvisY: [[0, 0], [0.3, -0.5], [0.42, -0.55], [0.5, -0.05], [0.62, 0.5], [0.85, 0.38], [1, 0.1]],
  spineY: [[0, 0], [0.3, -0.38], [0.46, -0.44], [0.56, 0.28], [0.85, 0.5], [1, 0.1]],
  chestY: [[0, 0], [0.32, -0.52], [0.47, -0.56], [0.58, 0.42], [0.85, 0.62], [1, 0.12]],
  shRX: [[0, 0.1], [0.3, 0.2], [0.44, 0.35], [0.55, -0.25], [0.8, -0.55], [1, 0]],
  shRY: [[0, 0.1], [0.3, -0.55], [0.44, -0.75], [0.55, 0.45], [0.82, 1.05], [1, 0.25]],
  shRZ: [[0, -0.32], [0.3, -0.7], [0.44, -0.5], [0.55, -1.02], [0.8, -0.45], [1, -0.35]],
  elRX: [[0, -0.55], [0.3, -1.05], [0.44, -0.75], [0.55, -0.3], [0.82, -1.0], [1, -0.6]],
  wrRX: [[0, -0.25], [0.42, 0.15], [0.55, -0.3], [0.8, -0.5], [1, -0.25]],
  wrRZ: [[0, 0], [0.44, 0.55], [0.55, -0.12], [0.8, -0.3], [1, 0]],
  shLY: [[0, 0], [0.32, -0.55], [0.55, 0.3], [0.85, 0.5], [1, 0]],
  shLZ: [[0, 0.32], [0.32, 0.75], [0.55, 0.5], [0.85, 0.85], [1, 0.35]],
  elLX: [[0, -0.5], [0.32, -0.4], [0.6, -0.8], [1, -0.5]],
  rootY: [[0, -0.06], [0.35, -0.12], [0.55, -0.04], [0.8, -0.07], [1, -0.06]],
  kneeR: [[0, 0.35], [0.35, 0.72], [0.55, 0.2], [1, 0.35]],
  kneeL: [[0, 0.35], [0.4, 0.5], [0.6, 0.3], [1, 0.35]],
}

const BH = {
  pelvisY: [[0, 0], [0.3, 0.55], [0.44, 0.6], [0.55, 0.1], [0.65, -0.4], [0.85, -0.32], [1, -0.08]],
  spineY: [[0, 0], [0.3, 0.42], [0.46, 0.48], [0.58, -0.25], [0.85, -0.42], [1, -0.08]],
  chestY: [[0, 0], [0.32, 0.58], [0.47, 0.62], [0.6, -0.38], [0.85, -0.52], [1, -0.1]],
  shRX: [[0, 0.1], [0.3, 0.35], [0.46, 0.4], [0.56, -0.2], [0.85, -0.4], [1, 0]],
  shRY: [[0, 0.1], [0.3, 0.85], [0.46, 0.95], [0.56, -0.35], [0.85, -0.85], [1, -0.15]],
  shRZ: [[0, -0.32], [0.3, -0.12], [0.46, -0.1], [0.56, -0.85], [0.85, -1.15], [1, -0.4]],
  elRX: [[0, -0.55], [0.3, -1.25], [0.46, -1.05], [0.56, -0.25], [0.85, -0.4], [1, -0.6]],
  wrRX: [[0, -0.25], [0.44, 0.1], [0.56, -0.35], [0.85, -0.45], [1, -0.25]],
  wrRZ: [[0, 0], [0.44, -0.5], [0.56, 0.12], [0.85, 0.25], [1, 0]],
  // left hand rides the racket through the take-back, then flies back for balance
  shLY: [[0, -0.3], [0.3, -0.75], [0.44, -0.8], [0.6, 0.5], [0.85, 0.8], [1, 0]],
  shLZ: [[0, 0.32], [0.3, 0.25], [0.44, 0.22], [0.65, 0.85], [0.85, 1.0], [1, 0.35]],
  shLX: [[0, 0.2], [0.44, 0.35], [0.65, -0.45], [0.85, -0.55], [1, 0.05]],
  elLX: [[0, -0.5], [0.3, -1.2], [0.44, -1.15], [0.65, -0.25], [1, -0.5]],
  rootY: [[0, -0.06], [0.35, -0.12], [0.55, -0.045], [0.8, -0.07], [1, -0.06]],
  kneeR: [[0, 0.35], [0.4, 0.55], [0.6, 0.28], [1, 0.35]],
  kneeL: [[0, 0.35], [0.35, 0.7], [0.55, 0.22], [1, 0.35]],
}

export function clipStroke(type, t) {
  const k = type === 'backhand' ? BH : FH
  const p = newPose()
  p.pelvis[1] = sample(k.pelvisY, t)
  p.spine[1] = sample(k.spineY, t)
  p.chest[1] = sample(k.chestY, t)
  p.chest[0] = 0.12
  p.shR = [sample(k.shRX, t), sample(k.shRY, t), sample(k.shRZ, t)]
  p.elR[0] = sample(k.elRX, t)
  p.wrR = [sample(k.wrRX, t), 0, sample(k.wrRZ, t)]
  p.shL[1] = sample(k.shLY, t)
  p.shL[2] = sample(k.shLZ, t)
  if (k.shLX) p.shL[0] = sample(k.shLX, t)
  p.elL[0] = sample(k.elLX, t)
  p.rootY = sample(k.rootY, t)
  p.kneeR[0] = sample(k.kneeR, t)
  p.kneeL[0] = sample(k.kneeL, t)
  p.hipR[0] = -p.kneeR[0] * 0.55
  p.hipL[0] = -p.kneeL[0] * 0.55
  p.ankL[0] = -0.15
  p.ankR[0] = -0.15
  return p
}

// Winner: hops with both arms up, small torso twist.
export function clipCelebrate(time) {
  const p = newPose()
  const hop = Math.abs(Math.sin(time * 4.2))
  p.rootY = -0.06 + hop * 0.26
  p.shL = [-0.25, 0, 2.55]
  p.shR = [-0.25, 0, -2.55]
  p.elL[0] = -0.3
  p.elR[0] = -0.3
  p.chest[0] = -0.1
  p.chest[1] = Math.sin(time * 2.1) * 0.2
  p.head[0] = -0.3
  const land = 1 - hop
  p.kneeL[0] = 0.18 + land * 0.5
  p.kneeR[0] = 0.18 + land * 0.5
  p.hipL[0] = -0.1 - land * 0.3
  p.hipR[0] = -0.1 - land * 0.3
  return p
}

// The other player, deflated: shoulders drop, head down, hands on hips-ish.
export function clipDejected(time) {
  const p = newPose()
  p.rootY = -0.1
  p.spine[0] = 0.22
  p.chest[0] = 0.28
  p.head[0] = 0.38
  p.chest[1] = Math.sin(time * 0.9) * 0.05
  p.shL = [0.15, 0, 0.2]
  p.shR = [0.15, 0, -0.2]
  p.elL[0] = -0.25
  p.elR[0] = -0.3
  p.kneeL[0] = 0.42
  p.kneeR[0] = 0.42
  p.hipL[0] = -0.26
  p.hipR[0] = -0.26
  return p
}

// Changeover walk.
export function clipWalk(time, speed01) {
  const p = newPose()
  const phase = time * 6.5
  const s = Math.sin(phase) * speed01
  p.hipL[0] = -0.05 + s * 0.5
  p.hipR[0] = -0.05 - s * 0.5
  p.kneeL[0] = 0.2 + Math.max(0, -s) * 1.0
  p.kneeR[0] = 0.2 + Math.max(0, s) * 1.0
  p.shL = [s * 0.45, 0, 0.3]
  p.shR = [-s * 0.45, 0.15, -0.4]
  p.elL[0] = -0.4
  p.elR[0] = -1.0
  p.wrR[0] = -0.3
  p.rootY = -0.03 + Math.abs(Math.sin(phase)) * 0.025 * speed01
  p.chest[0] = 0.08
  return p
}

// ---------------------------------------------------------------------------
// Blender + head tracking
// ---------------------------------------------------------------------------

const FADE = 0.18

export class PoseBlender {
  constructor(rig) {
    this.rig = rig
    this.state = null
    this.fadeFrom = newPose()
    this.fadeT = FADE
    this.out = newPose()
    this.last = newPose()
    this.headYaw = 0
    this.headPitch = 0
  }

  // Switch the active clip; snapshots the last applied pose to fade from.
  setState(name) {
    if (this.state === name) return false
    this.state = name
    copyPose(this.last, this.fadeFrom)
    this.fadeT = 0
    return true
  }

  apply(pose, dt) {
    this.fadeT = Math.min(FADE, this.fadeT + dt)
    const w = smooth(this.fadeT / FADE)
    const blended = w >= 1 ? pose : mixPose(this.fadeFrom, pose, w, this.out)
    copyPose(blended, this.last)
    applyPose(this.rig, blended)
  }
}

const _headPos = new THREE.Vector3()
const _headDir = new THREE.Vector3()
const _parentQuat = new THREE.Quaternion()

// Aim the head at the ball (clamped, damped). Call AFTER blender.apply.
export function headTrack(blender, targetWorld, dt, weight = 1) {
  const head = blender.rig.joints.head
  head.getWorldPosition(_headPos)
  _headDir.subVectors(targetWorld, _headPos)
  head.parent.getWorldQuaternion(_parentQuat).invert()
  _headDir.applyQuaternion(_parentQuat)

  const yaw = Math.max(-1.1, Math.min(1.1, Math.atan2(_headDir.x, _headDir.z))) * weight
  const horiz = Math.hypot(_headDir.x, _headDir.z)
  const pitch = Math.max(-0.5, Math.min(0.4, -Math.atan2(_headDir.y, horiz) * 0.8)) * weight

  const k = Math.min(1, dt * 10)
  blender.headYaw += (yaw - blender.headYaw) * k
  blender.headPitch += (pitch - blender.headPitch) * k
  head.rotation.y += blender.headYaw
  head.rotation.x += blender.headPitch
}
