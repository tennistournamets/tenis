import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { disposeObject, makeBlobShadow, makeBracketTree, makeFootball, makePadelRacket, makeScoreSlab, makeTennisBall } from './objects'
import { makeArena, makeOrbit, makeTennisRacket, makeTrophy } from './cinematicObjects'

const { clamp, lerp } = THREE.MathUtils
const smooth = (a, b, value) => {
  const x = clamp((value - a) / (b - a), 0, 1)
  return x * x * (3 - 2 * x)
}
const FOV = 30, CAM_Z = 18

// A single transparent canvas. Each composition lives in its own DOM-anchored
// group, so scroll is native and the product's buttons remain ordinary HTML.
export function createLandingWorld(host, { palette, reducedMotion = false, dprCap = 1.5, onContextLost } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true })
  const budgetDpr = () => Math.min(devicePixelRatio || 1, dprCap, Math.sqrt(2.6e6 / Math.max(1, innerWidth * innerHeight)))
  let dpr = budgetDpr()
  renderer.setPixelRatio(dpr)
  renderer.setClearColor(0x000000, 0)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  host.appendChild(renderer.domElement)
  const contextLost = (event) => { event.preventDefault(); onContextLost?.() }
  renderer.domElement.addEventListener('webglcontextlost', contextLost)

  const scene = new THREE.Scene()
  let environment = null
  try {
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100)
  camera.position.z = CAM_Z
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  try { environment = pmrem.fromScene(room, 0.04) }
  finally { room.dispose(); pmrem.dispose() }
  scene.environment = environment.texture
  scene.environmentIntensity = 0.72
  const key = new THREE.DirectionalLight(0xfff4da, 2.4)
  key.position.set(-5, 8, 10)
  const rim = new THREE.DirectionalLight(0xdfff8c, 2.1)
  rim.position.set(7, 4, -3)
  const fill = new THREE.DirectionalLight(0xaacbff, 0.85)
  fill.position.set(-6, -1, 3)
  scene.add(key, rim, fill, new THREE.HemisphereLight(0xffffff, 0x102820, 0.7))

  const hero = new THREE.Group()
  const racket = makeTennisRacket()
  const heroBall = makeTennisBall({ detail: 64 })
  const heroCourt = makeArena()
  const orbit = makeOrbit()
  const shadow = makeBlobShadow(1)
  heroCourt.position.set(0, -2.35, -0.6)
  heroCourt.rotation.set(0.58, -0.25, -0.06)
  heroCourt.scale.setScalar(0.83)
  shadow.position.set(0.2, -1.9, -0.1)
  shadow.rotation.x = -0.8
  shadow.scale.set(5, 2, 1)
  shadow.material.opacity = 0.5
  hero.add(orbit, heroCourt, shadow, racket, heroBall)
  scene.add(hero)

  const beats = [new THREE.Group(), new THREE.Group(), new THREE.Group()]
  const setupCourt = makeArena()
  setupCourt.rotation.set(0.68, -0.38, -0.05)
  setupCourt.scale.setScalar(0.67)
  setupCourt.position.y = -0.6
  const setupRacket = makeTennisRacket()
  setupRacket.scale.setScalar(0.54)
  setupRacket.position.set(0.65, 0.9, 0.7)
  setupRacket.rotation.set(-0.3, 0.15, -0.65)
  const setupBall = makeTennisBall()
  setupBall.scale.setScalar(0.43)
  setupBall.position.set(-1.5, 1.2, 0.7)
  beats[0].add(setupCourt, setupRacket, setupBall)

  const tree = makeBracketTree()
  tree.scale.setScalar(0.72)
  beats[1].add(tree)

  const liveCourt = makeArena()
  liveCourt.rotation.set(0.65, -0.18, -0.04)
  liveCourt.scale.setScalar(0.64)
  liveCourt.position.set(0, -0.9, -0.3)
  const score = makeScoreSlab({ width: 4.5, height: 1.5 })
  score.position.set(0, 1.6, 0.2)
  const liveBall = makeTennisBall()
  liveBall.scale.setScalar(0.23)
  beats[2].add(liveCourt, score, liveBall)
  scene.add(...beats)

  const tennisSet = new THREE.Group()
  const tileRacket = makeTennisRacket()
  tileRacket.scale.setScalar(0.61)
  tileRacket.rotation.z = -0.55
  const tileBall = makeTennisBall()
  tileBall.scale.setScalar(0.46)
  tileBall.position.set(-0.8, -0.3, 0.7)
  tennisSet.add(tileRacket, tileBall)
  const tiles = [tennisSet, makePadelRacket(), makeFootball()].map((obj, i) => ({ key: `sport-${['tennis', 'padel', 'football'][i]}`, obj, hover: 0, target: 0, angle: i * 0.55 }))
  for (const tile of tiles) scene.add(tile.obj)

  const trophy = makeTrophy()
  scene.add(trophy)
  const themed = [tree, score, tiles[1].obj]
  function setPalette(p) {
    themed.forEach(obj => obj.userData.setPalette?.(p))
    scene.environmentIntensity = p.isDark ? 0.72 : 0.9
  }
  setPalette(palette)

  let anchors = {}, rects = {}, time = 0, intro = reducedMotion ? 1 : 0
  const pointer = new THREE.Vector2(), cursor = new THREE.Vector2()
  let scroll = window.scrollY
  let scoreBeat = -1
  const pointScores = [[40, 30], [40, 40], ['AD', 40], [40, 40], [40, 'AD'], [0, 0], [15, 0], [15, 15]]
  function setAnchors(map) {
    anchors = map
    rects = {}
    for (const [key, el] of Object.entries(map)) {
      const r = el.getBoundingClientRect()
      rects[key] = { top: r.top + window.scrollY, left: r.left, width: r.width, height: r.height }
    }
  }

  function update(dt) {
    const vw = innerWidth, vh = innerHeight, sy = window.scrollY
    scroll = reducedMotion ? sy : lerp(scroll, sy, 1 - Math.exp(-dt * 14))
    time += reducedMotion ? 0 : dt
    intro = reducedMotion ? 1 : Math.min(1, intro + dt / 1.25)
    cursor.lerp(pointer, reducedMotion ? 1 : 1 - Math.exp(-dt * 5))
    const upp = 2 * CAM_Z * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) / vh
    const X = px => (px - vw / 2) * upp
    const Y = px => (vh / 2 - px) * upp
    const visible = r => r && r.width > 0 && r.height > 0 && r.top - sy < vh + 100 && r.top + r.height - sy > -100
    let any = false
    const hr = rects.hero
    hero.visible = !!visible(hr)
    if (hero.visible) {
      any = true
      const p = reducedMotion ? 0 : clamp(scroll / Math.max(1, hr.top + hr.height), 0, 1)
      const unit = Math.min(hr.width / 8.0, hr.height / 7.0) * upp
      hero.position.set(X(hr.left + hr.width * 0.5), Y(hr.top - sy + hr.height * 0.47), 0)
      hero.scale.setScalar(unit * (0.88 + 0.12 * smooth(0, 1, intro)))
      hero.rotation.y = cursor.x * 0.09 - p * 0.22
      hero.rotation.x = cursor.y * 0.035
      racket.position.set(0.55 + p * 0.5, 0.25 - p * 0.35 + Math.sin(time * 0.7) * 0.07, 0)
      racket.rotation.set(-0.2 + p * 0.35, -0.4 + p * 1.4 + cursor.x * 0.09, -0.53 - p * 0.55)
      heroBall.position.set(-1.13 + p * 2.3, 0.08 + Math.sin(time * 0.85) * 0.14 + Math.sin(p * Math.PI) * 1.3, 1.1 + p * 1.4)
      heroBall.scale.setScalar(0.86)
      heroBall.rotation.set(0.5 + time * 0.08, time * 0.19 + p * 3, -0.6 + p * 2)
      heroCourt.rotation.y = -0.25 + p * 0.42
      orbit.rotation.z = 0.25 + time * 0.02 + p * 0.4
    }

    const sticky = anchors.steps?.offsetWidth ? anchors.steps.getBoundingClientRect() : null
    let p = 0
    if (sticky) {
      for (let i = 1; i <= 3; i++) {
        const r = rects[`block-${i}`]
        if (r) p += clamp((vh * 0.65 - (r.top - scroll)) / Math.max(1, r.height), 0, 1)
      }
    }
    for (let i = 0; i < 3; i++) {
      const g = beats[i]
      let r, weight, progress
      if (sticky) {
        r = { left: sticky.left, top: sticky.top + sy, width: sticky.width, height: sticky.height }
        weight = i === 0 ? 1 - smooth(0.87, 1.14, p) : i === 1 ? smooth(0.87, 1.14, p) * (1 - smooth(1.87, 2.14, p)) : smooth(1.87, 2.14, p)
        progress = clamp(p - i, 0, 1)
      } else {
        r = rects[`step-${i + 1}`]
        weight = 1
        progress = r ? clamp((vh * 0.95 - (r.top - scroll)) / (vh * 0.65), 0, 1) : 0
      }
      if (reducedMotion) { weight = sticky ? (i === Math.min(2, Math.floor(p)) ? 1 : 0) : 1; progress = 0.65 }
      g.visible = !!visible(r) && weight > 0.002
      if (!g.visible) continue
      any = true
      const unit = Math.min(r.width / 7.4, r.height / 5.3) * upp
      g.position.set(X(r.left + r.width / 2), Y(r.top - sy + r.height * 0.48) - (1 - weight) * unit * 0.3, -1 * (1 - weight))
      g.scale.setScalar(unit * smooth(0, 1, weight))
      g.rotation.y = cursor.x * 0.07
      if (i === 0) {
        setupCourt.rotation.y = -0.38 + progress * 0.6
        setupRacket.rotation.y = 0.15 + progress * 0.6
        setupBall.rotation.y = time * 0.3
        setupBall.position.y = 1.2 + Math.sin(time) * 0.12
      } else if (i === 1) {
        tree.userData.setAssembly(reducedMotion ? 1 : clamp(progress * 1.75, 0, 1))
        tree.rotation.set(0.12, -0.3 + progress * 0.52, -0.035)
      } else {
        const beat = Math.floor(time * 0.48)
        if (beat !== scoreBeat) { scoreBeat = beat; score.userData.setScore(...pointScores[beat % pointScores.length]) }
        const phase = reducedMotion ? 0.4 : (time * 0.48 + progress * 0.5) % 2
        const u = phase < 1 ? phase : 2 - phase
        liveBall.position.set(lerp(-2.0, 2.0, u), -0.58 + Math.sin(u * Math.PI) * 1.5, 1.0)
        liveBall.rotation.z = time * 3
        score.rotation.y = -0.08 + cursor.x * 0.08
      }
    }

    tiles.forEach((tile, i) => {
      const r = rects[tile.key]
      tile.obj.visible = !!visible(r)
      if (!tile.obj.visible) return
      any = true
      const unit = Math.min(r.width / 4.4, r.height / 4.2) * upp
      tile.hover += (tile.target - tile.hover) * (1 - Math.exp(-dt * 6))
      tile.angle += reducedMotion ? 0 : dt * (0.12 + tile.hover * 0.7)
      tile.obj.position.set(X(r.left + r.width / 2), Y(r.top - sy + r.height * (i === 1 ? 0.64 : 0.5)) + Math.sin(time + i) * unit * 0.06, 0)
      tile.obj.scale.setScalar(unit * [1, 0.78, 1.23][i] * (1 + tile.hover * 0.07))
      tile.obj.rotation.set(0.16, Math.sin(tile.angle) * (i === 2 ? 1 : 0.42), i === 1 ? -0.35 : 0.05)
    })

    const tr = rects.trophy
    trophy.visible = !!visible(tr)
    if (trophy.visible) {
      any = true
      const p = reducedMotion ? 0.5 : clamp((vh - (tr.top - scroll)) / (vh + tr.height), 0, 1)
      const unit = Math.min(tr.width / 4, tr.height / 3.6) * upp
      trophy.position.set(X(tr.left + tr.width / 2), Y(tr.top - sy + tr.height * 0.55) + Math.sin(time * 0.8) * unit * 0.06, 0)
      trophy.scale.setScalar(unit)
      trophy.rotation.set(0.1, -0.6 + p * 1.4 + Math.sin(time * 0.35) * 0.12, -0.07)
    }
    return any
  }

  let prev = 0, avg = 16, lastInput = 0, skip = false, hadVisible = false
  function frame(now) {
    const dt = prev ? clamp((now - prev) / 1000, 0, 0.05) : 0.016
    prev = now
    avg += (dt * 1000 - avg) * 0.05
    if (avg > 26 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); avg = 16 }
    const any = update(dt)
    if (!any) {
      if (hadVisible) renderer.clear()
      hadVisible = false
      return
    }
    hadVisible = true
    if (now - lastInput > 4000 && !reducedMotion) { skip = !skip; if (skip) return }
    renderer.render(scene, camera)
  }
  function renderStatic() { update(0); renderer.render(scene, camera) }
  function resize() {
    camera.aspect = innerWidth / innerHeight
    camera.updateProjectionMatrix()
    dpr = Math.min(dpr, budgetDpr())
    renderer.setPixelRatio(dpr)
    renderer.setSize(innerWidth, innerHeight)
    setAnchors(anchors)
  }
  resize()
  return {
    frame, renderStatic, resize, setAnchors, setPalette,
    setReducedMotion(value) { reducedMotion = value; if (value) { pointer.set(0, 0); cursor.set(0, 0); tiles.forEach(tile => { tile.target = 0; tile.hover = 0 }) } },
    setPointer(x, y) { pointer.set(x, y); lastInput = performance.now() },
    setHover(key, value) { const tile = tiles.find(t => t.key === key); if (tile) tile.target = reducedMotion ? 0 : Number(value) },
    noteInput(now) { lastInput = now },
    dispose() {
      renderer.domElement.removeEventListener('webglcontextlost', contextLost)
      disposeObject(scene)
      environment.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    },
  }
  } catch (error) {
    renderer.domElement.removeEventListener('webglcontextlost', contextLost)
    disposeObject(scene)
    environment?.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
    throw error
  }
}
