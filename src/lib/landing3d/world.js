import * as THREE from 'three'

import {
  disposeObject,
  makeBlobShadow,
  makeBracketTree,
  makeCourtFloor,
  makeFootball,
  makeNet,
  makePadelRacket,
  makeScoreSlab,
  makeTennisBall,
} from './objects'

// One fixed, transparent full-viewport canvas behind the landing content.
// Every prop is anchored to a DOM "stage" element (data-stage="…") and placed
// on the z = 0 plane so it lines up with the layout at any viewport size:
//   world units per CSS px = visible height at z=0 / innerHeight.
// Scroll drives the choreography; pointer adds a little parallax.

const FOV = 30
const CAM_Z = 14
const { clamp, lerp } = THREE.MathUtils
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const outCubic = (t) => 1 - (1 - t) ** 3
const outBack = (t) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}

const SPORTS = ['tennis', 'padel', 'football']
const RING_BASE = [0.88, 0.6, 0.88]
const TILE_BASE = [1, 0.7, 1]
const POINTS = [
  [40, 30],
  [40, 40],
  ['AD', 40],
  [0, 0],
  [15, 0],
  [15, 15],
  [30, 15],
  [40, 15],
]

function docRect(el) {
  const r = el.getBoundingClientRect()
  return {
    top: r.top + window.scrollY,
    left: r.left + window.scrollX,
    width: r.width,
    height: r.height,
    visible: r.width > 0 && r.height > 0,
  }
}

export function createLandingWorld(host, { palette, reducedMotion = false, dprCap = 1.5, onContextLost = null } = {}) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
    // software / blocklisted GL → throw → parent falls back to the no-3D layout
    failIfMajorPerformanceCaveat: true,
  })
  // DPR: device ratio, capped by tier and by a ~2.6 Mpx drawing-buffer budget
  const PIXEL_BUDGET = 2.6e6
  const budgetDpr = () =>
    Math.min(window.devicePixelRatio || 1, dprCap, Math.sqrt(PIXEL_BUDGET / Math.max(1, window.innerWidth * window.innerHeight)))
  let dpr = budgetDpr()
  renderer.setPixelRatio(dpr)
  const handleContextLost = (e) => {
    e.preventDefault()
    if (onContextLost) onContextLost()
  }
  renderer.domElement.addEventListener('webglcontextlost', handleContextLost)
  renderer.setClearColor(0x000000, 0)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'
  host.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80)
  camera.position.set(0, 0, CAM_Z)
  camera.lookAt(0, 0, 0)

  const hemi = new THREE.HemisphereLight(0xffffff, 0x9aa89f, 0.9)
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(-6, 9, 10)
  const fill = new THREE.DirectionalLight(0xffffff, 0.35)
  fill.position.set(7, -3, 6)
  scene.add(hemi, key, fill)

  // ---- hero: big ball peeking from behind the demo card + court floor
  const heroBall = makeTennisBall()
  const heroShadow = makeBlobShadow(1)
  const heroFloor = makeCourtFloor({ width: 32 })
  heroFloor.rotation.x = -1.22
  heroShadow.rotation.x = -1.22
  scene.add(heroBall, heroShadow, heroFloor)

  // ---- "how it works" beats
  // beat 0: pick a sport — ring of the three sports, tennis wins
  const ring = new THREE.Group()
  const ringItems = [makeTennisBall(), makePadelRacket(), makeFootball()]
  ringItems[1].rotation.set(0.15, 0, -0.35)
  ring.add(...ringItems)
  // beat 1: the bracket assembles itself
  const beat2 = new THREE.Group()
  const tree = makeBracketTree()
  tree.scale.setScalar(0.58)
  beat2.add(tree)
  // beat 2: live score — ball crosses the net, scoreboard ticks
  const beat3 = new THREE.Group()
  const net = makeNet({ width: 4.8, height: 0.95 })
  net.position.set(0, -1.45, 0)
  const liveFloor = makeCourtFloor({ width: 32 })
  liveFloor.scale.setScalar(0.19)
  liveFloor.rotation.x = -1.2
  liveFloor.position.set(0, -1.46, -0.1)
  const slab = makeScoreSlab({ width: 3.0, height: 1.0 })
  slab.scale.setScalar(0.86)
  slab.position.set(0, 1.5, 0.3)
  const liveBall = makeTennisBall()
  liveBall.scale.setScalar(0.3)
  const liveShadow = makeBlobShadow(1)
  liveShadow.rotation.x = -1.2
  beat3.add(net, liveFloor, slab, liveBall, liveShadow)
  const beats = [ring, beat2, beat3]
  scene.add(...beats)

  // ---- sports tiles
  const tiles = SPORTS.map((sport, i) => ({
    key: `sport-${sport}`,
    obj: [makeTennisBall, makePadelRacket, makeFootball][i](),
    shadow: makeBlobShadow(1),
    hover: 0,
    hoverTarget: 0,
    spin: i * 1.7,
  }))
  for (const tile of tiles) scene.add(tile.obj, tile.shadow)

  const props = [
    heroBall,
    heroShadow,
    heroFloor,
    ...ringItems,
    tree,
    net,
    liveFloor,
    slab,
    liveBall,
    liveShadow,
    ...tiles.flatMap((t) => [t.obj, t.shadow]),
  ]

  function setPalette(p) {
    for (const obj of props) if (obj.userData.setPalette) obj.userData.setPalette(p)
    hemi.groundColor.set(p.isDark ? 0x24302a : 0x9aa89f)
    hemi.intensity = p.isDark ? 0.75 : 0.9
    key.intensity = p.isDark ? 1.25 : 1.4
  }
  setPalette(palette)

  // ---- anchors
  let anchors = {}
  let rects = {}
  function refreshRects() {
    rects = {}
    for (const [k, el] of Object.entries(anchors)) rects[k] = docRect(el)
  }
  function setAnchors(map) {
    anchors = map
    refreshRects()
  }

  const state = {
    time: 0,
    intro: reducedMotion ? 1 : 0,
    ringAngle: -Math.PI / 2,
    flight: reducedMotion ? 0.5 : 0,
    crossing: -1,
    pointer: new THREE.Vector2(),
    pointerSmooth: new THREE.Vector2(),
  }

  function updateBeat0(t, dt) {
    const s = smooth(0.6, 0.95, t)
    state.ringAngle += dt * 0.25 * (1 - s)
    const R = 1.6
    for (let i = 0; i < ringItems.length; i++) {
      const obj = ringItems[i]
      const ang = state.ringAngle + (i * Math.PI * 2) / 3 + Math.PI * 0.9 * t
      const x = Math.cos(ang) * R
      const z = Math.sin(ang) * R * 0.55
      const depth = (z / (R * 0.55) + 1) / 2
      let sc = (0.72 + 0.35 * depth) * RING_BASE[i]
      let px = x
      let py = Math.sin(state.time * 1.2 + i) * 0.08
      let pz = z
      if (i === 0) {
        px = lerp(px, 0, s)
        py = lerp(py, 0.1, s)
        pz = lerp(pz, 1.0, s)
        sc = lerp(sc, 1.55, s)
      } else {
        sc *= 1 - 0.62 * s
        py -= s * 0.95
        pz -= s * 1.6
      }
      obj.position.set(px, py, pz)
      obj.scale.setScalar(sc)
      obj.rotation.y += dt * 0.6
    }
  }

  function updateBeat1(t) {
    tree.userData.setAssembly(clamp(t * 1.3, 0, 1))
    beat2.rotation.y = state.pointerSmooth.x * 0.15
    beat2.rotation.x = -state.pointerSmooth.y * 0.08
  }

  function updateBeat2(t, dt) {
    if (!reducedMotion) state.flight += dt * 0.55
    const phase = t * 1.6 + state.flight
    const u = phase % 2
    const s = u < 1 ? u : 2 - u
    const crossing = Math.floor(phase)
    if (crossing !== state.crossing) {
      state.crossing = crossing
      const [a, b] = POINTS[((crossing % POINTS.length) + POINTS.length) % POINTS.length]
      slab.userData.setScore(a, b)
    }
    const x = lerp(-2.05, 2.05, s)
    const h = 4 * 1.35 * s * (1 - s)
    liveBall.position.set(x, -1.25 + h, 0.35)
    liveBall.rotation.z -= dt * 9 * (u < 1 ? 1 : -1)
    liveShadow.position.set(x, -1.44, 0.4)
    const squash = 1 - (h / 1.35) * 0.45
    liveShadow.scale.set(0.9 * squash, 0.9 * squash, 1)
    liveShadow.material.opacity = 0.55 * (1 - (h / 1.35) * 0.5)
    const pulse = 1 + 0.3 * Math.max(0, Math.sin(state.time * 5))
    slab.userData.liveDot.scale.setScalar(pulse)
  }

  const beatUpdaters = [updateBeat0, updateBeat1, updateBeat2]

  function placeBeat(i, X, Y, cx, cy, unit, w, t, inView, dt) {
    const g = beats[i]
    g.visible = inView && w > 0.002
    if (!g.visible) return false
    g.position.set(X(cx), Y(cy) - (1 - w) * unit * 0.7, 0)
    g.scale.setScalar(Math.max(0.0001, unit * outCubic(w)))
    beatUpdaters[i](t, dt)
    return true
  }

  function update(dt) {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const sy = window.scrollY
    const upp = (2 * CAM_Z * Math.tan(THREE.MathUtils.degToRad(FOV / 2))) / vh
    const W = (px) => px * upp
    const X = (px) => (px - vw / 2) * upp
    const Y = (px) => (vh / 2 - px) * upp

    state.time += dt
    if (!reducedMotion) state.intro = Math.min(1, state.intro + dt / 0.9)
    state.pointerSmooth.lerp(state.pointer, reducedMotion ? 1 : 1 - Math.exp(-dt * 6))
    let any = false

    // ---------------------------------------------------------------- hero
    const hr = rects.hero
    const heroOn = Boolean(hr && hr.visible)
    let heroIn = false
    if (heroOn) {
      const topV = hr.top - sy
      heroIn = topV + hr.height > -vh * 0.3 && topV < vh * 1.2
    }
    heroBall.visible = heroShadow.visible = heroFloor.visible = heroIn
    if (heroIn) {
      any = true
      const topV = hr.top - sy
      const mobile = vw < 640
      const rPx = clamp(hr.height * (mobile ? 0.34 : 0.36), 64, 190)
      const e = reducedMotion ? 0 : clamp(sy / Math.max(1, (hr.top + hr.height) * 0.8), 0, 1)
      let cx = mobile ? hr.left + hr.width / 2 : hr.left + hr.width - rPx * 0.55
      let cy = mobile ? topV + hr.height * 0.42 : topV + rPx * 0.28
      cx -= e * hr.width * 1.15
      cy += e * vh * 0.5
      cx += state.pointerSmooth.x * rPx * 0.3
      cy += state.pointerSmooth.y * rPx * 0.2 + Math.sin(state.time * 1.1) * rPx * 0.05
      const scale = W(rPx) * outBack(state.intro) * lerp(1, 0.35, e) * (1 - smooth(0.82, 1, e))
      heroBall.position.set(X(cx), Y(cy), 0)
      heroBall.scale.setScalar(Math.max(0.0001, scale))
      heroBall.rotation.y += dt * 0.35
      heroBall.rotation.z = -(e * hr.width * 1.15) / rPx
      heroBall.rotation.x = 0.3 + Math.sin(state.time * 0.5) * 0.1

      const floorY = topV + hr.height + (mobile ? 6 : 28)
      const fade = 1 - smooth(0.25, 0.85, e)
      const floorW = hr.width * (mobile ? 1.5 : 1.55)
      const floorCx = hr.left + hr.width * (mobile ? 0.5 : 0.58) + state.pointerSmooth.x * 12
      heroFloor.position.set(X(floorCx), Y(floorY), -1.2)
      heroFloor.scale.setScalar(Math.max(0.0001, W(floorW) / 32))
      heroFloor.material.opacity = fade * outCubic(state.intro)

      heroShadow.position.set(X(cx), Y(floorY - 2), -1.0)
      heroShadow.scale.set(W(rPx * 2.6), W(rPx * 2.6), 1)
      heroShadow.material.opacity = 0.28 * fade * outCubic(state.intro)
    }

    // -------------------------------------------------------- how it works
    const stickyEl = anchors.steps
    const stickyLive = stickyEl && stickyEl.offsetWidth > 0 ? stickyEl.getBoundingClientRect() : null
    if (stickyLive) {
      let p = 0
      for (let i = 1; i <= 3; i++) {
        const b = rects[`block-${i}`]
        if (!b) continue
        const topV = b.top - sy
        p += clamp((vh * 0.62 - topV) / Math.max(1, b.height), 0, 1)
      }
      if (reducedMotion) p = Math.min(2.999, Math.floor(p + 0.5)) + 0.999
      const inView = stickyLive.bottom > -vh * 0.1 && stickyLive.top < vh * 1.1
      const cx = stickyLive.left + stickyLive.width / 2
      const cy = stickyLive.top + stickyLive.height / 2
      const unit = W(Math.min(stickyLive.width, stickyLive.height)) / 5.2
      const ws = [
        1 - smooth(0.85, 1.2, p),
        smooth(0.8, 1.15, p) * (1 - smooth(1.85, 2.2, p)),
        smooth(1.8, 2.15, p),
      ]
      const ts = [clamp(p, 0, 1), clamp(p - 1, 0, 1), clamp(p - 2, 0, 1)]
      for (let i = 0; i < 3; i++) {
        if (placeBeat(i, X, Y, cx, cy, unit, ws[i], ts[i], inView, dt)) any = true
      }
    } else {
      for (let i = 0; i < 3; i++) {
        const r = rects[`step-${i + 1}`]
        if (!r || !r.visible) {
          beats[i].visible = false
          continue
        }
        const topV = r.top - sy
        const inView = topV + r.height > -vh * 0.15 && topV < vh * 1.15
        const w = reducedMotion ? 1 : clamp((vh * 0.92 - topV) / (vh * 0.35), 0, 1)
        const t = reducedMotion ? 1 : clamp((vh * 0.85 - topV) / (vh * 0.6), 0, 1)
        const unit = W(Math.min(r.width, r.height)) / 5.2
        if (placeBeat(i, X, Y, r.left + r.width / 2, topV + r.height / 2, unit, w, t, inView, dt)) any = true
      }
    }

    // --------------------------------------------------------------- tiles
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i]
      const r = rects[tile.key]
      if (!r || !r.visible) {
        tile.obj.visible = tile.shadow.visible = false
        continue
      }
      const topV = r.top - sy
      const inView = topV + r.height > -vh * 0.15 && topV < vh * 1.15
      tile.obj.visible = tile.shadow.visible = inView
      if (!inView) continue
      any = true
      const t = reducedMotion ? 1 : clamp((vh * 0.92 - topV) / (vh * 0.3), 0, 1)
      const eb = outBack(t)
      const unit = W(Math.min(r.width, r.height)) / 2.7
      tile.hover += (tile.hoverTarget - tile.hover) * (1 - Math.exp(-dt * 5))
      tile.spin += dt * (0.5 + tile.hover * 2.6)
      const floatY = Math.sin(state.time * 1.3 + i * 2) * 0.06
      const cx = r.left + r.width / 2
      const cy = topV + r.height * 0.46 - (1 - eb) * r.height * 0.9
      tile.obj.position.set(X(cx), Y(cy) + floatY * unit, 0)
      tile.obj.scale.setScalar(Math.max(0.0001, unit * TILE_BASE[i] * clamp(eb, 0, 1.3)))
      tile.obj.rotation.set(0.32, tile.spin, i === 1 ? -0.3 : 0)
      tile.shadow.position.set(X(cx), Y(topV + r.height * 0.9), -0.3)
      tile.shadow.scale.set(unit * 2.3, unit * 0.75, 1)
      tile.shadow.material.opacity = Math.max(0, 0.3 - floatY * 1.6) * t
    }

    return any
  }

  // Frame pacing: a rolling average of frame time drives adaptive DPR
  // (drops by 0.25 down to 1.0 when frames exceed 24 ms), and after 3 s
  // without scroll/pointer input the scene renders every other frame.
  let prev = 0
  let avgDt = 16
  let lastInput = 0
  let skip = false
  function noteInput(now) {
    lastInput = now
  }
  function frame(now) {
    const dt = prev ? clamp((now - prev) / 1000, 0, 0.05) : 0.016
    prev = now
    avgDt += (dt * 1000 - avgDt) * 0.1
    if (avgDt > 24 && dpr > 1.0) {
      dpr = Math.max(1.0, dpr - 0.25)
      renderer.setPixelRatio(dpr)
      avgDt = 16
    }
    const idle = now - lastInput > 3000
    if (idle) {
      skip = !skip
      if (skip) {
        // keep the clock moving but present nothing this frame
        update(dt)
        return
      }
    }
    if (update(dt)) renderer.render(scene, camera)
  }

  function renderStatic() {
    prev = 0
    update(0)
    renderer.render(scene, camera)
  }

  function resize() {
    const w = window.innerWidth
    const h = window.innerHeight
    dpr = Math.min(dpr, budgetDpr())
    renderer.setPixelRatio(dpr)
    renderer.setSize(w, h, false)
    camera.aspect = w / Math.max(1, h)
    camera.updateProjectionMatrix()
  }
  resize()

  function setPointer(nx, ny) {
    state.pointer.set(clamp(nx, -1, 1), clamp(ny, -1, 1))
    noteInput(performance.now())
  }

  function setHover(key, on) {
    const tile = tiles.find((t) => t.key === key)
    if (tile) tile.hoverTarget = on ? 1 : 0
  }

  function dispose() {
    // our own forced loss must not look like a runtime failure
    renderer.domElement.removeEventListener('webglcontextlost', handleContextLost)
    disposeObject(scene)
    renderer.dispose()
    renderer.forceContextLoss()
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
  }

  return { setPalette, setAnchors, refreshRects, setPointer, setHover, noteInput, frame, renderStatic, resize, dispose }
}
