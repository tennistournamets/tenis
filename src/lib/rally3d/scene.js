import * as THREE from 'three'

// Court metrics (meters, singles). X = along the court, Z = across, Y = up.
export const COURT = {
  halfLength: 11.885,
  halfWidth: 4.115,
  serviceX: 6.4,
  netHeight: 1.0,
  playerX: 10.9,
  contactHeight: 1.05,
}

const PALETTE = {
  fog: 0x131b16,
  surround: 0x22322a,
  court: 0x2e6650,
  courtLine: 0xe7efe9,
  net: 0xdfe6e1,
  post: 0x9aa8a0,
}

function makeCourtTexture() {
  // Plane is 32 x 15 m; texture maps 1 m -> 32 px.
  const PX = 32
  const W = 32 * PX
  const H = 15 * PX
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  const cx = W / 2
  const cy = H / 2
  const mx = (m) => cx + m * PX
  const my = (m) => cy + m * PX

  ctx.fillStyle = '#22322a'
  ctx.fillRect(0, 0, W, H)

  // court pad slightly larger than the lines
  ctx.fillStyle = '#2e6650'
  ctx.fillRect(mx(-13.2), my(-5.6), 26.4 * PX, 11.2 * PX)

  ctx.strokeStyle = 'rgba(238, 245, 240, 0.92)'
  ctx.lineWidth = 0.07 * PX

  const hl = COURT.halfLength
  const hw = COURT.halfWidth
  const sx = COURT.serviceX

  // outer lines
  ctx.strokeRect(mx(-hl), my(-hw), 2 * hl * PX, 2 * hw * PX)
  // service lines
  ctx.beginPath()
  ctx.moveTo(mx(-sx), my(-hw))
  ctx.lineTo(mx(-sx), my(hw))
  ctx.moveTo(mx(sx), my(-hw))
  ctx.lineTo(mx(sx), my(hw))
  // center service line
  ctx.moveTo(mx(-sx), my(0))
  ctx.lineTo(mx(sx), my(0))
  ctx.stroke()
  // center marks on baselines
  ctx.beginPath()
  ctx.moveTo(mx(-hl), my(0))
  ctx.lineTo(mx(-hl + 0.3), my(0))
  ctx.moveTo(mx(hl), my(0))
  ctx.lineTo(mx(hl - 0.3), my(0))
  ctx.stroke()

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

function makeNetTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, 256, 64)
  ctx.strokeStyle = 'rgba(226, 233, 228, 0.55)'
  ctx.lineWidth = 1
  for (let x = 0; x <= 256; x += 6) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, 64)
    ctx.stroke()
  }
  for (let y = 0; y <= 64; y += 6) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(256, y)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export function makeBlobShadowTexture() {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  const grad = ctx.createRadialGradient(64, 64, 4, 64, 64, 62)
  grad.addColorStop(0, 'rgba(0, 0, 0, 0.42)')
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  return new THREE.CanvasTexture(canvas)
}

function buildNet() {
  const group = new THREE.Group()

  const postGeo = new THREE.CylinderGeometry(0.05, 0.05, COURT.netHeight + 0.07, 10)
  const postMat = new THREE.MeshStandardMaterial({ color: PALETTE.post, roughness: 0.6 })
  for (const z of [-COURT.halfWidth - 0.6, COURT.halfWidth + 0.6]) {
    const post = new THREE.Mesh(postGeo, postMat)
    post.position.set(0, (COURT.netHeight + 0.07) / 2, z)
    post.castShadow = true
    group.add(post)
  }

  const span = 2 * (COURT.halfWidth + 0.6)
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(span, COURT.netHeight - 0.06),
    new THREE.MeshBasicMaterial({
      map: makeNetTexture(),
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  mesh.rotation.y = Math.PI / 2
  mesh.position.y = (COURT.netHeight - 0.06) / 2
  group.add(mesh)

  const band = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.09, span),
    new THREE.MeshStandardMaterial({ color: PALETTE.net, roughness: 0.5 }),
  )
  band.position.y = COURT.netHeight - 0.045
  group.add(band)

  return group
}

// Builds renderer + static world. Returns everything the component needs.
export function createWorld(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(PALETTE.fog, 26, 52)

  const camera = new THREE.PerspectiveCamera(
    38,
    container.clientWidth / Math.max(1, container.clientHeight),
    0.1,
    120,
  )

  const hemi = new THREE.HemisphereLight(0xbfe8d2, 0x14201a, 0.85)
  scene.add(hemi)

  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6)
  sun.position.set(9, 16, 7)
  sun.castShadow = true
  sun.shadow.mapSize.set(1024, 1024)
  sun.shadow.camera.left = -15
  sun.shadow.camera.right = 15
  sun.shadow.camera.top = 15
  sun.shadow.camera.bottom = -15
  sun.shadow.camera.far = 45
  sun.shadow.bias = -0.0015
  scene.add(sun)

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(32, 15),
    new THREE.MeshStandardMaterial({ map: makeCourtTexture(), roughness: 0.95 }),
  )
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  scene.add(buildNet())

  if (import.meta.env.DEV && typeof window !== 'undefined') {
    window.__rally = { scene, camera, renderer }
  }

  function resize() {
    const w = container.clientWidth
    const h = Math.max(1, container.clientHeight)
    renderer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  function dispose() {
    renderer.dispose()
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : []
      for (const mat of mats) {
        for (const key of Object.keys(mat)) {
          if (mat[key] && mat[key].isTexture) mat[key].dispose()
        }
        mat.dispose()
      }
    })
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }

  return { renderer, scene, camera, resize, dispose }
}
