import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'

import { addCap, buildRacket } from '../player'

// Quaternius Mannequin (CC0) tennis player.
// - The uniform is painted into the mesh VERTICES by dominant skin bone
//   (shirt / shorts / socks / shoes / skin) — it deforms with the body, so
//   nothing clips or floats. Reference look: classic Wimbledon kit.
// - Locomotion / idle / dance are the model's own mocap loops.
// - Strokes are a procedural kinetic chain applied to bones around WORLD
//   axes (independent of rigify bone rolls), so the contact pose is exact.

const RIG = {
  url: '/models/quaternius.glb',
  // GLTFLoader strips dots from node names ('DEF-spine.003' -> 'DEF-spine003')
  bones: {
    hips: 'DEF-hips',
    spine: 'DEF-spine002',
    chest: 'DEF-spine003',
    head: 'DEF-head',
    armR: 'DEF-upper_armR',
    foreR: 'DEF-forearmR',
    handR: 'DEF-handR',
    armL: 'DEF-upper_armL',
    foreL: 'DEF-forearmL',
    handL: 'DEF-handL',
  },
  height: 2.05,
  yaw: Math.PI, // exported facing -Z
}

const LOOPS = {
  ready: 'Rig|Idle_Loop',
  move: 'Rig|Jog_Fwd_Loop',
  sprint: 'Rig|Sprint_Loop',
  walk: 'Rig|Walk_Loop',
  celebrate: 'Rig|Dance_Loop',
  dejected: 'Rig|Crouch_Idle_Loop',
  stroke: 'Rig|Idle_Loop', // strokes ride on top of idle
  split: 'Rig|Jump_Land', // phase-synced landing into a wide stance
}

const FADE_RATE = 4.5 // softer crossfades (~0.25s)

// Tennis kits (reference: Wimbledon whites + brand green alternative)
const TENNIS_KITS = [
  {
    shirt: 0x2fbf8f,
    shorts: 0x22312c,
    sock: 0xf2f4f0,
    shoe: 0xffffff,
    skin: 0xd9a06b,
    cap: 0xf2f4f0,
    band: 0xf2f4f0,
    grip: 0x22312c,
  },
  {
    shirt: 0xf4f2ea,
    shorts: 0x27405a,
    sock: 0xf4f2ea,
    shoe: 0xffffff,
    skin: 0xb97f56,
    cap: 0xf4f2ea,
    band: 0x27405a,
    grip: 0x27405a,
  },
]

let sourcePromise = null

export function loadRigSource() {
  if (!sourcePromise) {
    const loader = new GLTFLoader()
    sourcePromise = loader.loadAsync(RIG.url).then((gltf) => ({ gltf }))
  }
  return sourcePromise
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const _q = new THREE.Quaternion()
const _pq = new THREE.Quaternion()
const _e = new THREE.Euler()
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

// Rotate a bone around a WORLD axis (robust against exporter bone rolls).
function rotateBoneWorld(bone, axisWorld, angle) {
  if (!bone || !angle) return
  bone.parent.getWorldQuaternion(_pq).invert()
  _axis.copy(axisWorld).applyQuaternion(_pq).normalize()
  _q.setFromAxisAngle(_axis, angle)
  bone.quaternion.premultiply(_q)
  bone.updateMatrixWorld(true)
}

function smooth(t) {
  const v = Math.min(1, Math.max(0, t))
  return v * v * (3 - 2 * v)
}

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

// Kinetic-chain envelopes, contact at t = 0.55 (normalized amplitudes).
const TRK = {
  turn: [[0, 0], [0.3, -1], [0.48, -0.95], [0.62, 0.55], [0.85, 0.75], [1, 0.1]],
  swing: [[0, 0], [0.32, -1], [0.48, -0.9], [0.58, 0.45], [0.8, 1], [1, 0.15]],
  lift: [[0, 0.15], [0.3, 0.7], [0.55, 0.62], [0.8, 0.95], [1, 0.25]],
  elbow: [[0, 0.35], [0.3, 0.85], [0.55, 0.12], [0.8, 0.55], [1, 0.35]],
  crouch: [[0, 0.3], [0.35, 1], [0.55, 0.35], [0.8, 0.55], [1, 0.35]],
}

// ---------------------------------------------------------------------------
// uniform painting
// ---------------------------------------------------------------------------

function regionColorFor(boneName, kit) {
  if (/DEF-(spine00[123]|shoulder|upper_arm)/.test(boneName)) return kit.shirt
  if (/DEF-(hips|thigh)/.test(boneName)) return kit.shorts
  if (/DEF-shin/.test(boneName)) return kit.sock
  if (/DEF-(foot|toe)/.test(boneName)) return kit.shoe
  return kit.skin // head, neck, forearms, hands, fingers
}

function paintUniform(mesh, kit) {
  const geo = mesh.geometry.clone()
  mesh.geometry = geo
  const count = geo.attributes.position.count
  const skinIndex = geo.attributes.skinIndex
  const skinWeight = geo.attributes.skinWeight
  const bones = mesh.skeleton.bones
  const colors = new Float32Array(count * 3)
  const color = new THREE.Color()

  for (let i = 0; i < count; i += 1) {
    // dominant influence bone
    let best = 0
    let bw = -1
    const w = [skinWeight.getX(i), skinWeight.getY(i), skinWeight.getZ(i), skinWeight.getW(i)]
    const idx = [skinIndex.getX(i), skinIndex.getY(i), skinIndex.getZ(i), skinIndex.getW(i)]
    for (let k = 0; k < 4; k += 1) {
      if (w[k] > bw) {
        bw = w[k]
        best = idx[k]
      }
    }
    const bone = bones[best]
    color.setHex(regionColorFor(bone ? bone.name : '', kit))
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  mesh.material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.72,
    vertexColors: true,
  })
}

// ---------------------------------------------------------------------------
// rigid accents (only on effectively-rigid bones: head, wrists)
// ---------------------------------------------------------------------------

function mat(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8 })
}

function buildCap(kit) {
  const g = new THREE.Group()
  addCap(g, kit, 0.125)
  return g
}

function buildWristband(kit) {
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.045, 12), mat(kit.band))
  band.castShadow = true
  return band
}

// ---------------------------------------------------------------------------
// actor
// ---------------------------------------------------------------------------

export function createSkinnedActor(source, kitIndex) {
  const { gltf } = source
  const kit = TENNIS_KITS[kitIndex] || TENNIS_KITS[0]
  const model = cloneSkeleton(gltf.scene)

  // normalize height by the skeleton span (mesh/armature scales often differ)
  model.updateMatrixWorld(true)
  let minY = Infinity
  let maxY = -Infinity
  model.traverse((obj) => {
    if (obj.isBone) {
      obj.getWorldPosition(_v)
      if (_v.y < minY) minY = _v.y
      if (_v.y > maxY) maxY = _v.y
    }
  })
  let span = maxY - minY
  if (!Number.isFinite(span) || span < 0.01) {
    const bbox = new THREE.Box3().setFromObject(model)
    span = Math.max(0.01, bbox.getSize(new THREE.Vector3()).y)
    minY = bbox.min.y
  }
  const scale = RIG.height / (span * 1.15)
  model.scale.setScalar(scale)
  model.position.y = -minY * scale
  model.rotation.y = RIG.yaw

  // paint the uniform into vertices
  model.traverse((obj) => {
    if (obj.isSkinnedMesh) {
      obj.castShadow = true
      obj.frustumCulled = false
      paintUniform(obj, kit)
    } else if (obj.isMesh) {
      obj.castShadow = true
    }
  })

  const group = new THREE.Group()
  const bob = new THREE.Group()
  bob.add(model)
  group.add(bob)

  const bones = {}
  for (const [key, name] of Object.entries(RIG.bones)) {
    bones[key] = model.getObjectByName(name) || null
  }

  // rigid accents on quasi-rigid bones
  model.updateMatrixWorld(true)
  const modelQuat = model.getWorldQuaternion(new THREE.Quaternion())

  // Attach a meter-authored piece to a bone. With alignModel=true the mount is
  // counter-rotated so the piece starts UPRIGHT in model space (rigify bone
  // axes are arbitrary — a cap authored Y-up would otherwise lie sideways);
  // it still follows the bone afterwards. posMeters is in model axes.
  function attach(bone, piece, posMeters, { alignModel = false, rotEuler = [0, 0, 0] } = {}) {
    if (!bone) return null
    const boneScale = bone.getWorldScale(_v).y || 1
    const inv = 1 / Math.max(0.0001, boneScale)
    const mount = new THREE.Group()
    mount.add(piece)
    mount.scale.setScalar(inv)

    const boneQuatInv = bone.getWorldQuaternion(new THREE.Quaternion()).invert()
    if (alignModel) {
      mount.quaternion.copy(boneQuatInv).multiply(modelQuat)
      mount.quaternion.multiply(_q.setFromEuler(_e.set(rotEuler[0], rotEuler[1], rotEuler[2])))
      // offset given in model axes -> bone local
      _v2.set(posMeters[0], posMeters[1], posMeters[2]).applyQuaternion(modelQuat).applyQuaternion(boneQuatInv)
      mount.position.copy(_v2).multiplyScalar(inv)
    } else {
      mount.rotation.fromArray(rotEuler)
      mount.position.set(posMeters[0] * inv, posMeters[1] * inv, posMeters[2] * inv)
    }
    bone.add(mount)
    mount.userData.baseQuat = mount.quaternion.clone()
    return mount
  }

  attach(bones.head, buildCap(kit), [0, 0.08, 0], { alignModel: true })
  attach(bones.handL, buildWristband(kit), [0, 0.005, 0])
  attach(bones.handR, buildWristband(kit), [0, 0.005, 0])
  // racket head extends past the fingers (+Y of the hand bone)
  attach(bones.handR, buildRacket(kit), [0, 0.05, 0.01])

  // --- animation ---
  const mixer = new THREE.AnimationMixer(model)
  const actions = {}
  for (const [key, clipName] of Object.entries(LOOPS)) {
    const clip = THREE.AnimationClip.findByName(gltf.animations, clipName)
    if (clip) {
      const action = mixer.clipAction(clip)
      action.play()
      action.setEffectiveWeight(key === 'ready' ? 1 : 0)
      actions[key] = action
    }
  }
  if (actions.split) actions.split.paused = true

  function actionKeyFor(ctx) {
    switch (ctx.mode) {
      case 'stroke':
        return 'stroke'
      case 'split':
        return 'split'
      case 'move':
        return ctx.gait === 1 && ctx.speed01 > 0.65 ? 'sprint' : 'move'
      case 'celebrate':
      case 'dejected':
      case 'walk':
        return ctx.mode
      default:
        return 'ready'
    }
  }

  let headYaw = 0
  let headPitch = 0

  function headTrackBones(ballPos, dt, weight) {
    const head = bones.head
    if (!head) return
    head.getWorldPosition(_v)
    const dir = _v.subVectors(ballPos, _v)
    head.parent.getWorldQuaternion(_pq).invert()
    dir.applyQuaternion(_pq)
    const yaw = Math.max(-1.0, Math.min(1.0, Math.atan2(dir.x, dir.z))) * weight
    const horiz = Math.hypot(dir.x, dir.z)
    const pitch = Math.max(-0.45, Math.min(0.35, -Math.atan2(dir.y, horiz) * 0.7)) * weight
    const k = Math.min(1, dt * 10)
    headYaw += (yaw - headYaw) * k
    headPitch += (pitch - headPitch) * k
    _q.setFromEuler(new THREE.Euler(headPitch, headYaw, 0))
    head.quaternion.multiply(_q)
  }

  // Procedural kinetic chain over the idle base, in world axes.
  function applyStroke(type, phase) {
    group.getWorldQuaternion(_pq)
    _fwd.set(0, 0, 1).applyQuaternion(_pq).setY(0).normalize() // towards the net
    _right.crossVectors(_fwd, UP).negate() // player's right hand side

    const dir = type === 'backhand' ? 1 : -1 // torso turn sign
    const turn = sample(TRK.turn, phase) * dir
    const swing = sample(TRK.swing, phase) * dir
    const lift = sample(TRK.lift, phase)
    const elbow = sample(TRK.elbow, phase)

    // hips lead, shoulders follow with more amplitude
    rotateBoneWorld(bones.hips, UP, turn * 0.25)
    rotateBoneWorld(bones.spine, UP, turn * 0.3)
    rotateBoneWorld(bones.chest, UP, turn * 0.4)

    // hitting arm: raise out of the body, sweep horizontally, elbow flexes
    // through the loop and extends into contact
    rotateBoneWorld(bones.armR, _fwd, -lift * 1.15)
    rotateBoneWorld(bones.armR, UP, swing * 1.05)
    rotateBoneWorld(bones.foreR, UP, swing * 0.4 + elbow * 0.9 * dir)

    // free arm balances opposite
    rotateBoneWorld(bones.armL, _fwd, lift * 0.5)
    rotateBoneWorld(bones.armL, UP, -swing * 0.45)

    return -0.04 - sample(TRK.crouch, phase) * 0.07 // root dip
  }

  return {
    group,
    update(dt, ctx) {
      const activeKey = actionKeyFor(ctx)
      const k = Math.min(1, dt * FADE_RATE)
      for (const [key, action] of Object.entries(actions)) {
        const target = key === activeKey ? 1 : 0
        const w = action.getEffectiveWeight()
        action.setEffectiveWeight(w + (target - w) * k)
      }

      if (activeKey === 'split' && actions.split) {
        actions.split.time = Math.min(1.24, Math.max(0, ctx.t01) * 0.5)
      }
      if (activeKey === 'move' && actions.move) {
        actions.move.timeScale = 0.7 + ctx.speed01 * 0.6
      } else if (actions.move) {
        actions.move.timeScale = 1
      }

      mixer.update(dt)

      let bobY = 0
      if (ctx.mode === 'stroke') {
        bobY = applyStroke(ctx.type, ctx.phase)
      }
      bob.position.y = bobY


      if (ctx.ballPos && ctx.trackWeight > 0 && ctx.mode !== 'celebrate' && ctx.mode !== 'dejected') {
        headTrackBones(ctx.ballPos, dt, ctx.trackWeight)
      }
    },
  }
}
