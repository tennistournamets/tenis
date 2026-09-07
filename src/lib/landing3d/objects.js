import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

import { COURT, makeBlobShadowTexture } from '../rally3d/scene'

// Thematic 3D props for the landing. Every builder returns a Group (or Mesh)
// whose userData.setPalette(palette) re-tints it from the CSS tokens, so the
// scene follows light/dark theme switches. Sizes are in "design units":
// balls have radius 1, the racket is ~2.7 tall, the bracket tree ~8 wide.

function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0, ...opts })
}

// ---------------------------------------------------------------- tennis ball
// Felt sphere in brand lime plus the classic two-lobed seam:
// (a cos t + b cos 3t, a sin t − b sin 3t, 2√(ab) sin 2t) lies on a sphere of radius a+b.
export function makeTennisBall({ radius = 1, detail = 40 } = {}) {
  const group = new THREE.Group()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')
  const grain = ctx.createImageData(128, 128)
  for (let i = 0; i < grain.data.length; i += 4) {
    const value = 100 + Math.round(hash(i) * 155)
    grain.data[i] = grain.data[i + 1] = grain.data[i + 2] = value
    grain.data[i + 3] = 255
  }
  ctx.putImageData(grain, 0, 0)
  const bump = new THREE.CanvasTexture(canvas)
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping
  bump.repeat.set(5, 3)
  const felt = new THREE.MeshPhysicalMaterial({ color: 0xaacb12, roughness: 0.96, envMapIntensity: 0.22, bumpMap: bump, bumpScale: 0.035, sheen: 0.45, sheenColor: 0xbace41, sheenRoughness: 0.95 })
  const seamMat = std(0xf5f7f3, { roughness: 0.55 })

  group.add(new THREE.Mesh(new THREE.SphereGeometry(radius, detail, Math.round(detail * 0.7)), felt))

  if (detail >= 64) {
    const fibers = []
    for (let i = 0; i < 6500; i++) {
      const y = 1 - (i / 6499) * 2
      const ring = Math.sqrt(1 - y * y)
      const angle = i * 2.399963229728653
      const x = Math.cos(angle) * ring, z = Math.sin(angle) * ring
      const length = radius * (1.008 + hash(i) * 0.009)
      fibers.push(x * radius, y * radius, z * radius, x * length, y * length, z * length)
    }
    const fiberGeo = new THREE.BufferGeometry()
    fiberGeo.setAttribute('position', new THREE.Float32BufferAttribute(fibers, 3))
    group.add(new THREE.LineSegments(fiberGeo, new THREE.LineBasicMaterial({ color: 0xbad52e, transparent: true, opacity: 0.28 })))
  }

  const a = 0.72 * radius
  const b = 0.28 * radius
  const c = 2 * Math.sqrt(a * b)
  const pts = []
  const N = 180
  for (let i = 0; i < N; i++) {
    const t = (i / N) * Math.PI * 2
    pts.push(
      new THREE.Vector3(
        a * Math.cos(t) + b * Math.cos(3 * t),
        a * Math.sin(t) - b * Math.sin(3 * t),
        c * Math.sin(2 * t),
      ),
    )
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5)
  group.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 160, radius * 0.025, 8, true), seamMat))

  group.userData.setPalette = (p) => {
    felt.color.set(0xaacb12)
  }
  return group
}

// ------------------------------------------------------------------- football
// Truncated-icosahedron pattern computed in the fragment shader: a weighted
// spherical Voronoi over the 12 icosahedron vertices (pentagons) and 20 face
// centres (hexagons). No texture, no seams at the poles, crisp at any zoom.
function icosahedronSites() {
  const geo = new THREE.IcosahedronGeometry(1, 0)
  const pos = geo.attributes.position
  const verts = []
  const faces = []
  const key = (v) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
  const seen = new Set()
  for (let i = 0; i < pos.count; i += 3) {
    const tri = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, i + k))
    for (const v of tri) {
      const k = key(v)
      if (!seen.has(k)) {
        seen.add(k)
        verts.push(v.clone().normalize())
      }
    }
    faces.push(tri[0].clone().add(tri[1]).add(tri[2]).normalize())
  }
  geo.dispose()
  return [...verts, ...faces] // 12 + 20
}

const FOOTBALL_FRAG = `
  float fbBest = -2.0;
  float fbSecond = -2.0;
  int fbIdx = 0;
  for (int i = 0; i < 32; i++) {
    float d = dot(vFbObj, uFbSites[i]) - (i < 12 ? uFbPentBias : 0.0);
    if (d > fbBest) { fbSecond = fbBest; fbBest = d; fbIdx = i; }
    else if (d > fbSecond) { fbSecond = d; }
  }
  float fbPanel = fbIdx < 12 ? 1.0 : 0.0;
  float fbSeam = smoothstep(0.0, uFbSeam, fbBest - fbSecond);
  vec3 fbCol = mix(diffuseColor.rgb, uFbPanel, fbPanel);
  diffuseColor.rgb = fbCol * mix(0.42, 1.0, fbSeam);
`

export function makeFootball({ radius = 1, detail = 48 } = {}) {
  const panelColor = new THREE.Color(0x14201b)
  const uniforms = {
    uFbSites: { value: icosahedronSites() },
    uFbPanel: { value: panelColor },
    uFbPentBias: { value: 0.055 },
    uFbSeam: { value: 0.022 },
  }
  const mat = std(0xf4f6f2, { roughness: 0.55 })
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFbObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFbObj = normalize(position);')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform vec3 uFbSites[32];\nuniform vec3 uFbPanel;\nuniform float uFbPentBias;\nuniform float uFbSeam;\nvarying vec3 vFbObj;',
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FOOTBALL_FRAG}`)
  }
  mat.customProgramCacheKey = () => 'landing-football'

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, detail, Math.round(detail * 0.75)), mat)
  // A football stays white with ink panels in both themes — it is the sport's
  // own iconography, not a UI surface.
  mesh.userData.setPalette = () => {}
  return mesh
}

// --------------------------------------------------------------- padel racket
// Solid perforated paddle: teardrop head with a hex grid of holes, extruded
// with a bevel; cap faces take the brand green, walls the ink.
export function makePadelRacket() {
  const group = new THREE.Group()

  const shape = new THREE.Shape()
  const headR = 1.15
  const headY = 1.5
  const throatHalf = 0.26
  shape.moveTo(-throatHalf, 0.1)
  shape.lineTo(-throatHalf, -1.15)
  shape.absarc(0, -1.15, throatHalf, Math.PI, 0, true)
  shape.lineTo(throatHalf, 0.1)
  shape.quadraticCurveTo(headR, 0.3, headR, headY)
  shape.absarc(0, headY, headR, 0, Math.PI, false)
  shape.quadraticCurveTo(-headR, 0.3, -throatHalf, 0.1)

  const holeR = 0.062
  const step = 0.25
  const rowH = step * Math.sin(Math.PI / 3)
  for (let row = -4; row <= 4; row++) {
    const y = headY + 0.05 + row * rowH
    const offset = row % 2 === 0 ? 0 : step / 2
    for (let col = -5; col <= 5; col++) {
      const x = col * step + offset
      const dx = x
      const dy = y - (headY + 0.05)
      if (dx * dx + dy * dy > 0.88 * 0.88) continue
      const hole = new THREE.Path()
      hole.absarc(x, y, holeR, 0, Math.PI * 2, true)
      shape.holes.push(hole)
    }
  }

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.34,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 22,
  })
  geo.translate(0, 0, -0.17)
  const faceMat = std(0x174e3a, { roughness: 0.42, metalness: 0.25, envMapIntensity: 0.3 })
  const wallMat = std(0x14201b, { roughness: 0.6, metalness: 0.1 })
  const paddle = new THREE.Mesh(geo, [faceMat, wallMat])
  group.add(paddle)

  const gripMat = std(0x14201b, { roughness: 0.9 })
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 1.05, 14), gripMat)
  grip.position.y = -0.62
  group.add(grip)
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.09, 14), std(0xc6f24e))
  butt.position.y = -1.19
  group.add(butt)

  group.userData.setPalette = (p) => {
    faceMat.color.set(0x174e3a)
    wallMat.color.set(0x14201b)
    gripMat.color.set(0x101918)
    butt.material.color.copy(p.lime)
  }
  return group
}

// ------------------------------------------------------------- bracket tree
// 8 → 4 → 2 → 1 slabs with elbow connectors. setAssembly(t) flies every slab
// from a deterministic scatter offset into place with a per-slab stagger.
function hash(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

export function makeBracketTree() {
  const group = new THREE.Group()
  const slabMat = std(0xffffff, { roughness: 0.6 })
  const winMat = std(0xe7f4ec, { roughness: 0.6 })
  const lineMat = new THREE.LineBasicMaterial({ color: 0xd8dcd6, transparent: true, opacity: 0.9 })

  const slabGeo = new RoundedBoxGeometry(1.7, 0.46, 0.12, 3, 0.08)
  const cols = [-3.4, -1.13, 1.13, 3.4]
  const rounds = [8, 4, 2, 1]
  const slabs = []
  const labelRows = []
  const labelCanvas = document.createElement('canvas')
  labelCanvas.width = 384
  labelCanvas.height = 2048
  const labelContext = labelCanvas.getContext('2d')
  const labelTexture = new THREE.CanvasTexture(labelCanvas)
  labelTexture.colorSpace = THREE.SRGBColorSpace
  const labelMaterial = new THREE.MeshBasicMaterial({ map: labelTexture, transparent: true, depthWrite: false, toneMapped: false })
  const names = ['A. Novak', 'M. Silva', 'J. Martin', 'L. Rossi', 'E. Wilson', 'R. Chen', 'S. Garcia', 'T. Kim']
  function drawLabels(p) {
    labelContext.clearRect(0, 0, 384, 2048)
    labelContext.textBaseline = 'middle'
    for (const { idx, name, winner } of labelRows) {
      const y = idx * 96 + 48
      labelContext.fillStyle = p.isDark ? '#edf5e8' : '#163326'
      labelContext.font = '500 30px system-ui, sans-serif'
      labelContext.textAlign = 'left'
      labelContext.fillText(name, 14, y)
      labelContext.textAlign = 'right'
      labelContext.font = '500 27px system-ui, sans-serif'
      labelContext.fillStyle = p.isDark ? '#d1f64b' : '#336b27'
      labelContext.fillText(winner ? '✓' : '—', 370, y)
    }
    labelTexture.needsUpdate = true
  }
  const ys = []
  for (let r = 0; r < rounds.length; r++) {
    const n = rounds[r]
    const spacing = 0.64 * 2 ** r
    const roundYs = []
    for (let i = 0; i < n; i++) {
      const y = (i - (n - 1) / 2) * spacing
      roundYs.push(y)
      const isWinner = r === rounds.length - 1 || i % 2 === 0
      const mesh = new THREE.Mesh(slabGeo, isWinner ? winMat : slabMat)
      const idx = slabs.length
      const labelGeo = new THREE.PlaneGeometry(1.57, 0.39)
      const uv = labelGeo.attributes.uv
      for (let j = 0; j < uv.count; j++) uv.setY(j, 1 - ((idx + 1) * 96 - uv.getY(j) * 96) / 2048)
      const label = new THREE.Mesh(labelGeo, labelMaterial)
      label.position.z = 0.066
      mesh.add(label)
      labelRows.push({ idx, name: names[i * 2 ** r] || names[0], winner: isWinner })
      mesh.userData.home = new THREE.Vector3(cols[r], y, 0)
      mesh.userData.scatter = new THREE.Vector3(
        (hash(idx) - 0.5) * 9,
        (hash(idx + 31) - 0.5) * 7,
        -3 - hash(idx + 77) * 4,
      )
      mesh.userData.delay = (r * 0.18 + hash(idx + 13) * 0.14) * 0.9
      mesh.userData.spin = (hash(idx + 5) - 0.5) * 2.2
      group.add(mesh)
      slabs.push(mesh)
    }
    ys.push(roundYs)
  }

  // connectors: child right edge → mid gap → parent y → parent left edge
  const segs = []
  for (let r = 0; r < rounds.length - 1; r++) {
    const midX = (cols[r] + cols[r + 1]) / 2
    for (let i = 0; i < rounds[r]; i++) {
      const cy = ys[r][i]
      const py = ys[r + 1][Math.floor(i / 2)]
      segs.push(cols[r] + 0.85, cy, 0, midX, cy, 0)
      segs.push(midX, cy, 0, midX, py, 0)
      if (i % 2 === 0) segs.push(midX, py, 0, cols[r + 1] - 0.85, py, 0)
    }
  }
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
  const lines = new THREE.LineSegments(lineGeo, lineMat)
  lines.position.z = 0.01
  group.add(lines)

  const tmp = new THREE.Vector3()
  group.userData.setAssembly = (t) => {
    let arrived = 0
    for (const s of slabs) {
      const local = THREE.MathUtils.clamp((t - s.userData.delay) / 0.45, 0, 1)
      const e = 1 - (1 - local) ** 3
      tmp.lerpVectors(s.userData.scatter, s.userData.home, e)
      s.position.copy(tmp)
      s.rotation.set(0, s.userData.spin * (1 - e), s.userData.spin * 0.4 * (1 - e))
      const sc = 0.6 + 0.4 * e
      s.scale.setScalar(sc)
      arrived += e
    }
    lineMat.opacity = THREE.MathUtils.clamp((arrived / slabs.length - 0.55) / 0.45, 0, 1) * 0.9
  }
  group.userData.setAssembly(1)

  group.userData.setPalette = (p) => {
    drawLabels(p)
    slabMat.color.copy(p.surface)
    winMat.color.copy(p.primaryMuted)
    lineMat.color.copy(p.isDark ? p.muted : p.border)
  }
  return group
}

// ---------------------------------------------------------------------- net
export function makeNet({ width = 4.6, height = 0.95 } = {}) {
  const group = new THREE.Group()
  const postMat = std(0x14201b, { roughness: 0.5, metalness: 0.15 })
  const bandMat = std(0xffffff, { roughness: 0.5 })
  const meshMat = new THREE.LineBasicMaterial({ color: 0x5e6b64, transparent: true, opacity: 0.55 })

  for (const x of [-width / 2, width / 2]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, height + 0.08, 10), postMat)
    post.position.set(x, (height + 0.08) / 2, 0)
    group.add(post)
  }
  const band = new THREE.Mesh(new THREE.BoxGeometry(width, 0.08, 0.05), bandMat)
  band.position.y = height - 0.04
  group.add(band)

  const segs = []
  const cell = 0.11
  for (let x = -width / 2; x <= width / 2 + 1e-6; x += cell) segs.push(x, 0, 0, x, height - 0.08, 0)
  for (let y = 0; y <= height - 0.08 + 1e-6; y += cell) segs.push(-width / 2, y, 0, width / 2, y, 0)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3))
  group.add(new THREE.LineSegments(geo, meshMat))

  group.userData.setPalette = (p) => {
    postMat.color.copy(p.ink)
    bandMat.color.copy(p.surface)
    meshMat.color.copy(p.muted)
  }
  return group
}

// ------------------------------------------------------------- court floor
// Transparent plane with the real court geometry (COURT metrics from rally3d)
// drawn as lines; tinted by the primary token.
export function makeCourtFloor({ width = 12 } = {}) {
  const PX = 40
  const W = 32 * PX
  const H = 15 * PX
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4

  function draw(color) {
    ctx.clearRect(0, 0, W, H)
    const cx = W / 2
    const cy = H / 2
    const mx = (m) => cx + m * PX
    const my = (m) => cy + m * PX
    ctx.strokeStyle = color
    ctx.lineWidth = 0.09 * PX
    ctx.lineJoin = 'round'
    const hl = COURT.halfLength
    const hw = COURT.halfWidth
    const sx = COURT.serviceX
    ctx.strokeRect(mx(-hl), my(-hw), 2 * hl * PX, 2 * hw * PX)
    ctx.beginPath()
    ctx.moveTo(mx(-sx), my(-hw))
    ctx.lineTo(mx(-sx), my(hw))
    ctx.moveTo(mx(sx), my(-hw))
    ctx.lineTo(mx(sx), my(hw))
    ctx.moveTo(mx(-sx), my(0))
    ctx.lineTo(mx(sx), my(0))
    ctx.moveTo(mx(0), my(-hw - 0.6))
    ctx.lineTo(mx(0), my(hw + 0.6))
    ctx.stroke()
    texture.needsUpdate = true
  }
  draw('rgba(15, 123, 77, 0.42)')

  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 1 })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, (width * 15) / 32), mat)
  mesh.userData.setPalette = (p) => {
    const c = p.primary
    draw(`rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${p.isDark ? 0.45 : 0.42})`)
  }
  return mesh
}

// ---------------------------------------------------------------- shadow
export function makeBlobShadow(size = 1) {
  const mat = new THREE.MeshBasicMaterial({
    map: makeBlobShadowTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.7,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat)
  mesh.userData.setPalette = () => {}
  return mesh
}

// ------------------------------------------------------------- score slab
// Ink slab with a lime monospace score and a coral LIVE dot — the landing's
// "black bar with lime score" motif in 3D.
export function makeScoreSlab({ width = 3.0, height = 1.0 } = {}) {
  const group = new THREE.Group()
  const slabMat = std(0x101512, { roughness: 0.55, metalness: 0.05 })
  const slab = new THREE.Mesh(new RoundedBoxGeometry(width, height, 0.16, 3, 0.1), slabMat)
  group.add(slab)

  const canvas = document.createElement('canvas')
  canvas.width = 768
  canvas.height = 256
  const ctx = canvas.getContext('2d')
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4

  const state = { a: 40, b: 30, nameA: 'A. Novak', nameB: 'M. Silva', lime: '#C6F24E', muted: '#96A39A', accent: '#FF5A48' }
  function draw() {
    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#10221e'
    ctx.beginPath()
    ctx.roundRect(4, 4, W - 8, H - 8, 18)
    ctx.fill()
    ctx.textBaseline = 'middle'
    ctx.font = '500 30px "Golos Text", system-ui, sans-serif'
    ctx.fillStyle = '#F2F5F1'
    ctx.textAlign = 'left'
    ctx.fillText(`${state.nameA} — ${state.nameB}`, 88, 74)
    ctx.font = '600 24px "JetBrains Mono", ui-monospace, monospace'
    ctx.fillStyle = state.muted
    ctx.fillText('LIVE · DEMO', 88, 118)
    ctx.font = '700 92px "JetBrains Mono", ui-monospace, monospace'
    ctx.textAlign = 'right'
    ctx.fillStyle = state.lime
    ctx.fillText(String(state.b), W - 44, 96)
    const bw = ctx.measureText(String(state.b)).width
    ctx.fillStyle = state.muted
    ctx.font = '500 60px "JetBrains Mono", ui-monospace, monospace'
    ctx.fillText('—', W - 44 - bw - 26, 96)
    const dw = ctx.measureText('—').width
    ctx.fillStyle = state.lime
    ctx.font = '700 92px "JetBrains Mono", ui-monospace, monospace'
    ctx.fillText(String(state.a), W - 44 - bw - 26 - dw - 26, 96)
    texture.needsUpdate = true
  }
  draw()
  if (document.fonts && document.fonts.load) {
    Promise.all([
      document.fonts.load('700 92px "JetBrains Mono"'),
      document.fonts.load('500 30px "Golos Text"'),
    ])
      .then(draw)
      .catch(() => {})
  }

  // canvas is 3:1, so the face plane is width × width/3 (== height when height = width/3)
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(width, (width * canvas.height) / canvas.width),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }),
  )
  face.position.z = 0.081
  group.add(face)

  const dotMat = std(0xff5a48, { roughness: 0.4, emissive: 0xff5a48, emissiveIntensity: 0.35 })
  // sits where the canvas leaves room, left of the names line (56px of 768)
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), dotMat)
  dot.position.set(-width / 2 + (56 / canvas.width) * width, height / 2 - (74 / canvas.height) * height, 0.1)
  group.add(dot)
  group.userData.liveDot = dot

  group.userData.setScore = (a, b) => {
    state.a = a
    state.b = b
    draw()
  }
  group.userData.setPalette = (p) => {
    state.lime = `#${p.lime.getHexString()}`
    state.accent = `#${p.accent.getHexString()}`
    dotMat.color.copy(p.accent)
    dotMat.emissive.copy(p.accent)
    draw()
  }
  return group
}

// -------------------------------------------------------------- disposal
export function disposeObject(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set()
  root.traverse((obj) => {
    if (obj.geometry && !geometries.has(obj.geometry)) { geometries.add(obj.geometry); obj.geometry.dispose() }
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : []
    for (const mat of mats) {
      if (materials.has(mat)) continue
      materials.add(mat)
      for (const key of Object.keys(mat)) {
        const v = mat[key]
        if (v?.isTexture && !textures.has(v)) { textures.add(v); v.dispose() }
      }
      mat.dispose()
    }
  })
}
