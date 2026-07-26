import * as THREE from 'three'

// Athletic tennis player (~7 head-heights) assembled from primitives with a
// real joint hierarchy so the animation layer can drive the kinetic chain:
//   root -> pelvis -> spine -> chest -> { neck -> head,
//            clavL -> shL -> elL -> wrL (hand),
//            clavR -> shR -> elR -> wrR (hand + racket) }
//        -> hipL -> kneeL -> ankL (foot), hipR -> kneeR -> ankR (foot)
// Local space: the player faces +Z; the director rotates the root.

export const KITS = {
  a: {
    shirt: 0x2fbf8f,
    shirtDark: 0x27a379,
    shorts: 0x1d2b25,
    cap: 0xf2f4f0,
    band: 0xf2f4f0,
    skin: 0xd9a06b,
    sock: 0xf2f4f0,
    shoe: 0x2a3b33,
    grip: 0x1d2b25,
  },
  b: {
    shirt: 0xefede4,
    shirtDark: 0xded9c9,
    shorts: 0x27405a,
    cap: 0x27405a,
    band: 0x27405a,
    skin: 0xb97f56,
    sock: 0xefede4,
    shoe: 0xf2f4f0,
    grip: 0x27405a,
  },
}

// Segment lengths (meters)
export const BODY = {
  hip: 1.0, // pelvis joint height in rest
  thigh: 0.46,
  shin: 0.44,
  spine: 0.13, // pelvis -> spine joint
  chest: 0.24, // spine -> chest joint
  neck: 0.3, // chest joint -> neck joint
  headLift: 0.1,
  headR: 0.115,
  clavW: 0.075,
  shoulderW: 0.155, // clav joint -> shoulder joint (out)
  upperArm: 0.3,
  forearm: 0.27,
}

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, ...opts })
}

function capsule(radius, length, material, { scaleX = 1, scaleZ = 1 } = {}) {
  const cyl = Math.max(0.01, length - 2 * radius)
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, cyl, 4, 12), material)
  mesh.scale.x = scaleX
  mesh.scale.z = scaleZ
  mesh.castShadow = true
  return mesh
}

// A limb segment hanging down -Y from its joint. Optionally split into two
// colored parts (e.g. sleeve + skin, shorts + skin).
function limbDown(length, radius, parts) {
  const group = new THREE.Group()
  let offset = 0
  for (const part of parts) {
    const len = part.frac * length
    const m = capsule(radius * (part.radius || 1), len, part.material)
    m.position.y = -(offset + len / 2)
    group.add(m)
    offset += len
  }
  return group
}

function makeStringsTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, 64, 64)
  ctx.strokeStyle = 'rgba(235, 240, 236, 0.85)'
  ctx.lineWidth = 1
  for (let i = 4; i < 64; i += 7) {
    ctx.beginPath()
    ctx.moveTo(i, 0)
    ctx.lineTo(i, 64)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(0, i)
    ctx.lineTo(64, i)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function buildRacket(kit) {
  // +Y runs from the butt cap up through the head.
  const racket = new THREE.Group()
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x394a42,
    roughness: 0.4,
    metalness: 0.35,
  })

  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.023, 0.21, 8), mat(kit.grip, { roughness: 0.9 }))
  grip.position.y = 0.105
  grip.castShadow = true
  racket.add(grip)

  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.018, 8), frameMat)
  butt.position.y = 0.005
  racket.add(butt)

  // V-throat
  for (const side of [-1, 1]) {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.14, 6), frameMat)
    shaft.position.set(side * 0.045, 0.27, 0)
    shaft.rotation.z = -side * 0.55
    shaft.castShadow = true
    racket.add(shaft)
  }

  const head = new THREE.Group()
  head.position.y = 0.5
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.015, 8, 26), frameMat)
  rim.scale.y = 1.3
  rim.castShadow = true
  head.add(rim)
  const strings = new THREE.Mesh(
    new THREE.CircleGeometry(0.138, 22),
    new THREE.MeshBasicMaterial({
      map: makeStringsTexture(),
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  strings.scale.y = 1.3
  head.add(strings)
  racket.add(head)

  return racket
}

function buildArm(kit, sideX) {
  const clav = new THREE.Group()
  clav.position.set(sideX * BODY.clavW, BODY.chest - 0.02, 0)

  const shoulder = new THREE.Group()
  shoulder.position.set(sideX * BODY.shoulderW, 0, 0)
  clav.add(shoulder)

  // deltoid "sleeve"
  const deltoid = new THREE.Mesh(new THREE.SphereGeometry(0.085, 14, 12), mat(kit.shirtDark))
  deltoid.position.y = -0.02
  deltoid.castShadow = true
  shoulder.add(deltoid)

  const upper = limbDown(BODY.upperArm, 0.052, [
    { frac: 0.42, material: mat(kit.shirtDark), radius: 1.18 }, // sleeve
    { frac: 0.58, material: mat(kit.skin, { roughness: 0.55 }) },
  ])
  shoulder.add(upper)

  const elbow = new THREE.Group()
  elbow.position.y = -BODY.upperArm
  shoulder.add(elbow)

  const fore = limbDown(BODY.forearm, 0.046, [
    { frac: 0.82, material: mat(kit.skin, { roughness: 0.55 }) },
    { frac: 0.18, material: mat(kit.band), radius: 1.35 }, // wristband
  ])
  elbow.add(fore)

  const wrist = new THREE.Group()
  wrist.position.y = -BODY.forearm
  elbow.add(wrist)

  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), mat(kit.skin, { roughness: 0.55 }))
  hand.scale.set(0.9, 1.3, 0.8)
  hand.position.y = -0.045
  hand.castShadow = true
  wrist.add(hand)

  return { clav, shoulder, elbow, wrist }
}

function buildLeg(kit, sideX) {
  const hip = new THREE.Group()
  hip.position.set(sideX * 0.105, -0.04, 0)

  const thigh = limbDown(BODY.thigh, 0.073, [
    { frac: 0.42, material: mat(kit.shorts), radius: 1.12 }, // shorts leg
    { frac: 0.58, material: mat(kit.skin, { roughness: 0.55 }) },
  ])
  hip.add(thigh)

  const knee = new THREE.Group()
  knee.position.y = -BODY.thigh
  hip.add(knee)

  const shin = limbDown(BODY.shin, 0.052, [
    { frac: 0.68, material: mat(kit.skin, { roughness: 0.55 }) },
    { frac: 0.32, material: mat(kit.sock), radius: 1.12 }, // sock
  ])
  knee.add(shin)

  const ankle = new THREE.Group()
  ankle.position.y = -BODY.shin
  knee.add(ankle)

  const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.075, 0.23), mat(kit.shoe, { roughness: 0.85 }))
  shoe.position.set(0, -0.045, 0.045)
  shoe.castShadow = true
  ankle.add(shoe)
  const toe = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), mat(kit.shoe, { roughness: 0.85 }))
  toe.scale.set(0.95, 0.72, 1)
  toe.position.set(0, -0.055, 0.16)
  toe.castShadow = true
  ankle.add(toe)

  return { hip, knee, ankle }
}

export function createPlayer(kit) {
  const root = new THREE.Group()

  const pelvis = new THREE.Group()
  pelvis.position.y = BODY.hip
  root.add(pelvis)

  const shortsMesh = capsule(0.16, 0.34, mat(kit.shorts), { scaleZ: 0.82 })
  shortsMesh.position.y = 0.02
  pelvis.add(shortsMesh)

  const spine = new THREE.Group()
  spine.position.y = BODY.spine
  pelvis.add(spine)

  const waist = capsule(0.145, 0.3, mat(kit.shirt), { scaleZ: 0.78 })
  waist.position.y = 0.08
  spine.add(waist)

  const chest = new THREE.Group()
  chest.position.y = BODY.chest
  spine.add(chest)

  const ribcage = capsule(0.175, 0.36, mat(kit.shirt), { scaleX: 1.18, scaleZ: 0.78 })
  ribcage.position.y = 0.06
  chest.add(ribcage)

  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.062, 0.014, 8, 16), mat(kit.shirtDark))
  collar.rotation.x = Math.PI / 2
  collar.position.y = BODY.neck - 0.07
  chest.add(collar)

  const neckMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.056, 0.11, 10), mat(kit.skin, { roughness: 0.55 }))
  neckMesh.position.y = BODY.neck - 0.045
  neckMesh.castShadow = true
  chest.add(neckMesh)

  const neck = new THREE.Group()
  neck.position.y = BODY.neck
  chest.add(neck)

  const head = new THREE.Group()
  head.position.y = BODY.headLift
  neck.add(head)

  const skull = new THREE.Mesh(new THREE.SphereGeometry(BODY.headR, 18, 14), mat(kit.skin, { roughness: 0.5 }))
  skull.scale.y = 1.12
  skull.castShadow = true
  head.add(skull)

  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(BODY.headR + 0.012, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.52),
    mat(kit.cap, { roughness: 0.8 }),
  )
  cap.position.y = 0.024
  cap.rotation.x = 0.12
  head.add(cap)
  const visor = new THREE.Mesh(new THREE.CylinderGeometry(BODY.headR + 0.012, BODY.headR + 0.012, 0.016, 14, 1, false, -Math.PI / 3.4, Math.PI / 1.7), mat(kit.cap, { roughness: 0.8 }))
  visor.scale.z = 1.65
  visor.position.set(0, 0.05, 0.012)
  visor.rotation.x = -0.08
  head.add(visor)

  const armL = buildArm(kit, -1)
  const armR = buildArm(kit, 1)
  chest.add(armL.clav)
  chest.add(armR.clav)

  const racket = buildRacket(kit)
  // Grip sits in the right hand, head continuing past the fist.
  racket.position.y = -0.1
  racket.rotation.x = Math.PI
  armR.wrist.add(racket)

  const legL = buildLeg(kit, -1)
  const legR = buildLeg(kit, 1)
  pelvis.add(legL.hip)
  pelvis.add(legR.hip)

  return {
    group: root,
    racket,
    joints: {
      pelvis,
      spine,
      chest,
      neck,
      head,
      clavL: armL.clav,
      shL: armL.shoulder,
      elL: armL.elbow,
      wrL: armL.wrist,
      clavR: armR.clav,
      shR: armR.shoulder,
      elR: armR.elbow,
      wrR: armR.wrist,
      hipL: legL.hip,
      kneeL: legL.knee,
      ankL: legL.ankle,
      hipR: legR.hip,
      kneeR: legR.knee,
      ankR: legR.ankle,
    },
  }
}
