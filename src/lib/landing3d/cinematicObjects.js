import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'

const material = (color, options = {}) => new THREE.MeshStandardMaterial({ color, ...options })
const mesh = (geometry, mat, x = 0, y = 0, z = 0) => {
  const result = new THREE.Mesh(geometry, mat)
  result.position.set(x, y, z)
  return result
}

// A real open string bed, a bevelled graphite frame and individually wrapped grip.
// The strings share one geometry; the entire racket costs only a few draw calls.
export function makeTennisRacket() {
  const racket = new THREE.Group()
  const carbon = new THREE.MeshPhysicalMaterial({ color: 0x152629, metalness: 0.65, roughness: 0.26, clearcoat: 0.9, clearcoatRoughness: 0.22 })
  const lime = material(0xcafa42, { metalness: 0.25, roughness: 0.3 })
  const gripMat = material(0x11191c, { roughness: 0.95 })
  const points = []
  for (let i = 0; i < 96; i++) {
    const a = i / 96 * Math.PI * 2
    points.push(new THREE.Vector3(Math.cos(a) * 1.13, 1.08 + Math.sin(a) * 1.48, 0))
  }
  const curve = new THREE.CatmullRomCurve3(points, true)
  racket.add(mesh(new THREE.TubeGeometry(curve, 128, 0.105, 10, true), carbon))
  const stripe = mesh(new THREE.TubeGeometry(curve, 128, 0.037, 6, true), lime, 0, 0, 0.09)
  racket.add(stripe)
  const strings = []
  const rx = 1.035, ry = 1.37, cy = 1.08
  for (let x = -0.96; x <= 0.97; x += 0.12) {
    const h = ry * Math.sqrt(1 - (x / rx) ** 2)
    strings.push(x, cy - h, 0.014, x, cy + h, 0.014)
  }
  for (let y = -1.26; y <= 1.27; y += 0.12) {
    const w = rx * Math.sqrt(1 - (y / ry) ** 2)
    strings.push(-w, cy + y, 0, w, cy + y, 0)
  }
  const stringGeo = new THREE.BufferGeometry()
  stringGeo.setAttribute('position', new THREE.Float32BufferAttribute(strings, 3))
  racket.add(new THREE.LineSegments(stringGeo, new THREE.LineBasicMaterial({ color: 0xd6e0c9, transparent: true, opacity: 0.64 })))
  for (const side of [-1, 1]) {
    const throat = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.63, -0.1, 0),
      new THREE.Vector3(side * 0.44, -0.65, 0),
      new THREE.Vector3(side * 0.16, -1.23, 0),
    ])
    racket.add(mesh(new THREE.TubeGeometry(throat, 20, 0.085, 8, false), carbon))
  }
  racket.add(mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.6, 12), carbon, 0, -1.38))
  racket.add(mesh(new THREE.CylinderGeometry(0.19, 0.2, 1.25, 12), gripMat, 0, -2.13))
  const wrapPoints = []
  for (let i = 0; i <= 400; i++) {
    const a = i / 400 * Math.PI * 2 * 11
    wrapPoints.push(new THREE.Vector3(Math.cos(a) * 0.197, -2.74 + i / 400 * 1.23, Math.sin(a) * 0.197))
  }
  racket.add(mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(wrapPoints), 400, 0.012, 4, false), material(0x526064, { roughness: 1 })))
  racket.add(mesh(new THREE.CylinderGeometry(0.225, 0.235, 0.13, 8), lime, 0, -2.79))
  racket.userData.setPalette = () => {}
  return racket
}

export function makeArena() {
  const arena = new THREE.Group()
  const base = material(0x102829, { roughness: 0.42, metalness: 0.3 })
  const top = material(0x084b31, { roughness: 0.92, envMapIntensity: 0.2 })
  const ink = material(0xe4eedd, { roughness: 0.8 })
  arena.add(mesh(new RoundedBoxGeometry(8.8, 0.22, 5.3, 2, 0.1), base, 0, -0.13))
  arena.add(mesh(new THREE.BoxGeometry(8.35, 0.025, 4.87), top, 0, 0))
  // Length runs along X. Doubles sidelines, singles sidelines and service boxes.
  for (const z of [-2.14, -1.62, 1.62, 2.14]) arena.add(mesh(new THREE.BoxGeometry(7.7, 0.015, 0.028), ink, 0, 0.023, z))
  for (const x of [-3.85, 3.85]) arena.add(mesh(new THREE.BoxGeometry(0.028, 0.015, 4.3), ink, x, 0.024))
  for (const x of [-2.08, 2.08]) arena.add(mesh(new THREE.BoxGeometry(0.028, 0.015, 3.24), ink, x, 0.024))
  arena.add(mesh(new THREE.BoxGeometry(4.16, 0.015, 0.028), ink, 0, 0.024))
  const net = new THREE.Group()
  const netPoints = []
  for (let z = -2.32; z <= 2.33; z += 0.1) netPoints.push(0, 0.04, z, 0, 0.67, z)
  for (let y = 0.04; y < 0.68; y += 0.085) netPoints.push(0, y, -2.32, 0, y, 2.32)
  const netGeo = new THREE.BufferGeometry()
  netGeo.setAttribute('position', new THREE.Float32BufferAttribute(netPoints, 3))
  net.add(new THREE.LineSegments(netGeo, new THREE.LineBasicMaterial({ color: 0xbdcdc5, transparent: true, opacity: 0.45 })))
  net.add(mesh(new THREE.BoxGeometry(0.035, 0.045, 4.7), ink, 0, 0.68))
  for (const z of [-2.35, 2.35]) net.add(mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.79, 8), base, 0, 0.35, z))
  arena.add(net)
  const edge = material(0xc6f24e, { emissive: 0xc6f24e, emissiveIntensity: 0.6, roughness: 0.5 })
  arena.add(mesh(new THREE.BoxGeometry(8.55, 0.019, 0.025), edge, 0, -0.08, 2.64))
  arena.userData.setPalette = () => {}
  return arena
}

export function makeTrophy() {
  const trophy = new THREE.Group()
  const gold = new THREE.MeshPhysicalMaterial({ color: 0xdbd887, metalness: 0.93, roughness: 0.2, clearcoat: 0.65 })
  const dark = material(0x15282a, { metalness: 0.55, roughness: 0.32 })
  const bowl = [ [0.12, 0], [0.28, 0.06], [0.32, 0.3], [0.53, 0.53], [0.79, 0.83], [0.92, 1.25], [0.96, 1.6], [0.9, 1.63], [0.86, 1.27], [0.73, 0.88], [0.48, 0.59], [0.24, 0.39], [0.12, 0.34] ].map(([x, y]) => new THREE.Vector2(x, y))
  trophy.add(mesh(new THREE.LatheGeometry(bowl, 64), gold, 0, -0.05))
  trophy.add(mesh(new THREE.CylinderGeometry(0.13, 0.23, 0.65, 24), gold, 0, -0.37))
  trophy.add(mesh(new THREE.CylinderGeometry(0.6, 0.67, 0.13, 48), gold, 0, -0.74))
  trophy.add(mesh(new RoundedBoxGeometry(1.6, 0.5, 1.2, 3, 0.07), dark, 0, -1.04))
  trophy.add(mesh(new THREE.BoxGeometry(0.75, 0.21, 0.02), gold, 0, -1.03, 0.61))
  for (const side of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(side * 0.91, 1.32, 0), new THREE.Vector3(side * 1.43, 1.24, 0),
      new THREE.Vector3(side * 1.32, 0.58, 0), new THREE.Vector3(side * 0.52, 0.29, 0),
    ])
    trophy.add(mesh(new THREE.TubeGeometry(curve, 48, 0.073, 10, false), gold))
  }
  trophy.userData.setPalette = () => {}
  return trophy
}

export function makeOrbit() {
  const points = []
  for (let i = 0; i <= 160; i++) {
    const angle = i / 160 * Math.PI * 2
    points.push(new THREE.Vector3(Math.cos(angle) * 3.5, Math.sin(angle) * 3.5, 0))
  }
  const orbit = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x91b875, transparent: true, opacity: 0.16 }))
  orbit.rotation.set(0.92, -0.37, 0.25)
  return orbit
}
