import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { disposeObject, makeBracketTree } from './objects'
import { makeOrbit } from './cinematicObjects'
import { makeConfetti, makeEntryCard, makeEntryPair, makeMedal, makePodium, makeStandings } from './tournamentObjects'

const { clamp, lerp } = THREE.MathUtils
const smooth = (a, b, value) => {
  const x = clamp((value - a) / (b - a), 0, 1)
  return x * x * (3 - 2 * x)
}
const FOV = 30, CAM_Z = 18

// A single transparent canvas. Each composition lives in its own DOM-anchored
// group, so scroll is native and the product's buttons remain ordinary HTML.
export function createLandingWorld(host, { palette, reducedMotion = false, compact = false, dprCap = 1.5, onContextLost } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: compact ? 'low-power' : 'high-performance', failIfMajorPerformanceCaveat: true })
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
    const heroPodium = makePodium()
    heroPodium.scale.setScalar(1.22)
    heroPodium.position.set(0.2, -0.25, -0.4)
    const heroMedal = makeMedal()
    heroMedal.scale.setScalar(0.56)
    const heroEntry = makeEntryCard()
    heroEntry.scale.setScalar(0.64)
    const orbit = makeOrbit()
    const heroConfetti = makeConfetti(compact ? 12 : 38)
    hero.add(orbit, heroPodium, heroMedal, heroEntry, heroConfetti)
    scene.add(hero)

    const beats = [new THREE.Group(), new THREE.Group(), new THREE.Group()]
    const entries = compact ? null : makeEntryPair()
    if (entries) { entries.scale.setScalar(1.05); beats[0].add(entries) }

    // Keep the assembling tournament bracket as the central story beat.
    const tree = makeBracketTree()
    tree.scale.setScalar(0.72)
    beats[1].add(tree)

    const winners = compact ? null : makePodium()
    const winnerConfetti = compact ? null : makeConfetti()
    if (winners) {
      winners.rotation.set(0.12, -0.25, 0)
      winners.scale.setScalar(1.04)
      beats[2].add(winners, winnerConfetti)
    }
    scene.add(...beats)

    const themed = [tree]
    const tiles = []
    let groups = null
    if (!compact) {
      const knockout = makeBracketTree()
      knockout.scale.setScalar(0.42)
      const league = makeStandings()
      league.scale.setScalar(0.82)
      groups = makeEntryPair()
      groups.scale.setScalar(0.68)
      const double = new THREE.Group()
      const upperTree = makeBracketTree(), lowerTree = makeBracketTree()
      upperTree.scale.setScalar(0.33)
      lowerTree.scale.setScalar(0.26)
      upperTree.position.set(-0.1, 0.6, 0.1)
      lowerTree.position.set(0.2, -0.9, -0.3)
      double.add(upperTree, lowerTree)
      tiles.push(...[knockout, league, groups, double].map((obj, i) => ({ key: `format-${['knockout', 'league', 'groups', 'double'][i]}`, obj, baseScale: obj.scale.x, hover: 0, target: 0, angle: i * 0.55 })))
      for (const tile of tiles) scene.add(tile.obj)
      themed.push(knockout, upperTree, lowerTree)
    }

    const trophy = compact ? null : makeMedal()
    if (trophy) scene.add(trophy)
    function setPalette(p) {
      themed.forEach(obj => obj.userData.setPalette?.(p))
      scene.environmentIntensity = p.isDark ? 0.72 : 0.9
    }
    setPalette(palette)

    let anchors = {}, rects = {}, time = 0, intro = reducedMotion ? 1 : 0
    const pointer = new THREE.Vector2(), cursor = new THREE.Vector2()
    let scroll = window.scrollY
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
        heroPodium.rotation.set(0.12 + p * 0.08, -0.35 + p * 0.9 + Math.sin(time * 0.3) * 0.08, 0)
        heroPodium.userData.setRise(reducedMotion ? 1 : smooth(0, 0.8, intro))
        heroEntry.position.set(-2.5 + p * 0.4, 0.6 + Math.sin(time * 0.7) * 0.12, 0.45)
        heroEntry.rotation.set(0.04, 0.3 + p * 0.8, -0.16 - p * 0.14)
        heroMedal.position.set(2.35 - p * 0.3, 0.75 + Math.sin(time * 0.8 + 2) * 0.1, 0.15)
        heroMedal.rotation.set(0.08, -0.4 + p * 1.2, 0.25)
        heroConfetti.userData.animate(time, smooth(0.35, 1, intro))
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
        if (compact && i !== 1) { g.visible = false; continue }
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
          entries.userData.setAssembly(reducedMotion ? 1 : smooth(0, 0.75, progress), time)
          entries.rotation.y = -0.12 + progress * 0.24
        } else if (i === 1) {
          tree.userData.setAssembly(reducedMotion ? 1 : clamp(progress * 1.75, 0, 1))
          tree.rotation.set(0.12, -0.3 + progress * 0.52, -0.035)
        } else {
          winners.userData.setRise(reducedMotion ? 1 : smooth(0, 0.8, progress))
          winners.rotation.y = -0.25 + progress * 0.55 + cursor.x * 0.12
          winnerConfetti.userData.animate(time, reducedMotion ? 1 : smooth(0.2, 0.85, progress))
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
        tile.obj.position.set(X(r.left + r.width / 2), Y(r.top - sy + r.height * 0.5) + Math.sin(time + i) * unit * 0.06, 0)
        tile.obj.scale.setScalar(unit * tile.baseScale * (1 + tile.hover * 0.07))
        tile.obj.rotation.set(0.1, Math.sin(tile.angle) * 0.26, -0.035)
        if (i === 2) groups.userData.setAssembly(1, time)
      })

      const tr = rects.trophy
      if (trophy) trophy.visible = !!visible(tr)
      if (trophy?.visible) {
        any = true
        const p = reducedMotion ? 0.5 : clamp((vh - (tr.top - scroll)) / (vh + tr.height), 0, 1)
        const unit = Math.min(tr.width / 3.3, tr.height / 3.9) * upp
        trophy.position.set(X(tr.left + tr.width / 2), Y(tr.top - sy + tr.height * 0.7) + Math.sin(time * 0.8) * unit * 0.06, 0)
        trophy.scale.setScalar(unit)
        trophy.rotation.set(0.1, -0.6 + p * 1.4 + Math.sin(time * 0.35) * 0.12, -0.07)
      }
      return any
    }

    let prev = 0, avg = 16, lastInput = 0, skip = false, hadVisible = false, lastMobileFrame = 0
    function frame(now) {
      // Keep touch scrolling responsive: mobile artwork renders at up to 30 fps.
      if (compact && now - lastMobileFrame < 32) return
      lastMobileFrame = now
      const dt = prev ? clamp((now - prev) / 1000, 0, 0.05) : 0.016
      prev = now
      avg += (dt * 1000 - avg) * 0.05
      if (avg > (compact ? 42 : 26) && dpr > 1) { dpr = Math.max(1, dpr - 0.25); renderer.setPixelRatio(dpr); avg = 16 }
      const any = update(dt)
      if (!any) {
        if (hadVisible) renderer.clear()
        hadVisible = false
        return
      }
      hadVisible = true
      if (!compact && now - lastInput > 4000 && !reducedMotion) { skip = !skip; if (skip) return }
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
