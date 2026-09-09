import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { makeTrophy } from './cinematicObjects'

const dark = () => new THREE.MeshStandardMaterial({ color: 0x132427, metalness: 0.55, roughness: 0.3 })
const gold = () => new THREE.MeshPhysicalMaterial({ color: 0xd9bc63, metalness: 0.88, roughness: 0.24, clearcoat: 0.6 })
function addMesh(group, geometry, material, x = 0, y = 0, z = 0) {
  const obj = new THREE.Mesh(geometry, material)
  obj.position.set(x, y, z)
  group.add(obj)
  return obj
}
function faceTexture(width, height, draw) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  draw(canvas.getContext('2d'), width, height)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthWrite: false })
}
function label(group, value, width, height, x, y, z, color = '#d1f64b') {
  const mat = faceTexture(256, 128, ctx => {
    ctx.fillStyle = color
    ctx.font = '500 88px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(value, 128, 65)
  })
  return addMesh(group, new THREE.PlaneGeometry(width, height), mat, x, y, z)
}

// Solid engraved medallion with two folded fabric ribbons.
export function makeMedal() {
  const medal = new THREE.Group()
  const metal = gold()
  const disc = addMesh(medal, new THREE.CylinderGeometry(0.82, 0.82, 0.13, 64), metal)
  disc.rotation.x = Math.PI / 2
  addMesh(medal, new THREE.TorusGeometry(0.72, 0.034, 8, 80), metal, 0, 0, 0.08)
  addMesh(medal, new THREE.TorusGeometry(0.61, 0.009, 6, 80), metal, 0, 0, 0.082)
  const ring = addMesh(medal, new THREE.TorusGeometry(0.13, 0.035, 8, 32), metal, 0, 0.85, 0)
  ring.rotation.y = 0.16
  label(medal, '1', 0.8, 0.65, 0, 0.02, 0.077, '#695221')
  const ribbon = new THREE.MeshStandardMaterial({ color: 0x69794d, roughness: 0.85, metalness: 0.03, side: THREE.DoubleSide })
  const ribbonEdge = new THREE.MeshStandardMaterial({ color: 0xd1f64b, roughness: 0.8, side: THREE.DoubleSide })
  for (const side of [-1, 1]) {
    const shape = new THREE.Shape()
    shape.moveTo(side * 0.06, 0.88)
    shape.lineTo(side * 0.73, 2.23)
    shape.lineTo(side * 0.32, 2.37)
    shape.lineTo(-side * 0.12, 1.06)
    shape.closePath()
    const strip = addMesh(medal, new THREE.ExtrudeGeometry(shape, { depth: 0.025, bevelEnabled: false }), ribbon, 0, 0, -0.06)
    strip.rotation.y = side * 0.12
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(side * 0.03, 1.06, -0.02), new THREE.Vector3(side * 0.54, 2.28, -0.02)])
    addMesh(medal, new THREE.TubeGeometry(curve, 1, 0.018, 4, false), ribbonEdge)
  }
  return medal
}

// These are visual participant cards, not a ticket-selling or credential feature.
export function makeEntryCard({ name = 'ORBIT', seed = '01', color = '#d1f64b' } = {}) {
  const card = new THREE.Group()
  const rim = new THREE.MeshStandardMaterial({ color: 0x577268, metalness: 0.55, roughness: 0.33 })
  addMesh(card, new RoundedBoxGeometry(2.08, 2.7, 0.15, 3, 0.11), rim)
  const face = faceTexture(512, 672, (ctx, w, h) => {
    ctx.fillStyle = '#102222'
    ctx.beginPath(); ctx.roundRect(4, 4, w - 8, h - 8, 24); ctx.fill()
    ctx.fillStyle = '#93a89f'
    ctx.font = '500 23px system-ui, sans-serif'
    ctx.fillText('BRACKETA / 01', 38, 67)
    ctx.strokeStyle = '#4e665c'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(38, 100); ctx.lineTo(w - 38, 100); ctx.stroke()
    ctx.fillStyle = color
    ctx.font = '600 178px system-ui, sans-serif'
    ctx.fillText(seed, 30, 315)
    ctx.font = '600 60px system-ui, sans-serif'
    ctx.fillStyle = '#f0f5ec'
    ctx.fillText(name, 37, 424)
    ctx.fillStyle = '#93a89f'; ctx.font = '400 23px system-ui, sans-serif'
    ctx.fillText('01 / 16', 38, 475)
    ctx.fillStyle = color
    ctx.beginPath(); ctx.arc(48, 587, 6, 0, Math.PI * 2); ctx.fill()
    ctx.font = '500 23px system-ui, sans-serif'; ctx.fillText('01 / 08', 68, 596)
    ctx.fillStyle = '#78938a'
    for (let i = 0; i < 32; i++) ctx.fillRect(38 + i * 13.4, 636, i % 3 ? 3 : 7, 14)
  })
  addMesh(card, new THREE.PlaneGeometry(2.04, 2.65), face, 0, 0, 0.08)
  const clip = addMesh(card, new THREE.TorusGeometry(0.14, 0.038, 8, 24), rim, 0, 1.4, 0)
  clip.scale.x = 1.6
  return card
}

export function makeEntryPair() {
  const group = new THREE.Group()
  const entries = [makeEntryCard({ name: 'ORBIT', seed: '01' }), makeEntryCard({ name: 'NOVA', seed: '02', color: '#a9b8ff' })]
  entries.forEach(card => group.add(card))
  const connector = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1.35, 0, -0.3), new THREE.Vector3(1.35, 0, -0.3)]), new THREE.LineBasicMaterial({ color: 0x87a170, transparent: true, opacity: 0.4 }))
  group.add(connector)
  group.userData.setAssembly = (p, time = 0) => {
    entries.forEach((card, i) => {
      const side = i === 0 ? -1 : 1
      card.position.set(side * (1.25 + (1 - p) * 0.65), Math.sin(time * 0.7 + i * 2) * 0.1 + side * (1 - p) * 0.5, i * -0.25)
      card.rotation.set(0.02, side * (-0.18 + (1 - p) * 0.3), side * (0.03 + (1 - p) * 0.19))
    })
  }
  group.userData.setAssembly(1)
  return group
}

export function makePodium({ withTrophy = true } = {}) {
  const group = new THREE.Group()
  const podiumMaterial = dark()
  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0xd1f64b, emissive: 0xc6f24e, emissiveIntensity: 0.22, roughness: 0.4, metalness: 0.25 })
  const columns = []
  const heights = [0.85, 1.4, 0.6]
  heights.forEach((height, i) => {
    const column = new THREE.Group()
    addMesh(column, new RoundedBoxGeometry(1.6, height, 1.55, 3, 0.055), podiumMaterial, 0, height / 2)
    addMesh(column, new THREE.BoxGeometry(1.48, 0.035, 1.43), edgeMaterial, 0, height + 0.004)
    label(column, String([2, 1, 3][i]), 0.58, 0.42, 0, height * 0.52, 0.781, i === 1 ? '#d1f64b' : '#91a79e')
    column.position.set((i - 1) * 1.7, -1.6, 0)
    group.add(column)
    columns.push(column)
  })
  const trophy = withTrophy ? makeTrophy() : null
  if (trophy) { trophy.scale.setScalar(0.75); trophy.position.set(0, 0.82, 0); group.add(trophy) }
  group.userData.setRise = p => {
    columns.forEach((column, i) => {
      const s = 0.25 + 0.75 * THREE.MathUtils.smoothstep(p, i * 0.08, 0.65 + i * 0.08)
      column.scale.y = s
    })
    if (trophy) trophy.position.y = 0.82 - (1 - columns[1].scale.y) * 1.4
  }
  return group
}

export function makeStandings() {
  const group = new THREE.Group()
  addMesh(group, new RoundedBoxGeometry(4.0, 2.8, 0.18, 3, 0.1), dark())
  const face = faceTexture(800, 560, (ctx, w, h) => {
    ctx.fillStyle = '#102222'; ctx.beginPath(); ctx.roundRect(4, 4, w - 8, h - 8, 20); ctx.fill()
    ctx.fillStyle = '#91a79e'; ctx.font = '500 22px system-ui, sans-serif'; ctx.fillText('BRACKETA / 02', 40, 60)
    ctx.fillStyle = '#eef4e9'; ctx.font = '600 38px system-ui, sans-serif'; ctx.fillText('01 / 04', 40, 116)
    const teams = ['ORBIT', 'NOVA', 'ATLAS', 'PULSE']
    teams.forEach((name, i) => {
      const y = 197 + i * 91
      ctx.fillStyle = i === 0 ? '#2a3b29' : '#162a27'; ctx.beginPath(); ctx.roundRect(28, y - 40, 744, 75, 8); ctx.fill()
      ctx.font = '500 30px system-ui, sans-serif'; ctx.fillStyle = i === 0 ? '#d1f64b' : '#8fa59b'
      ctx.fillText(`0${i + 1}`, 48, y + 6)
      ctx.fillStyle = '#eef4e9'; ctx.fillText(name, 145, y + 6)
      ctx.textAlign = 'right'; ctx.fillStyle = '#d1f64b'; ctx.fillText(String([9, 6, 3, 0][i]), 741, y + 6); ctx.textAlign = 'left'
    })
  })
  addMesh(group, new THREE.PlaneGeometry(3.94, 2.76), face, 0, 0, 0.095)
  return group
}

export function makeConfetti(count = 44) {
  const confetti = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.07, 0.15), new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.35, side: THREE.DoubleSide }), count)
  const dummy = new THREE.Object3D()
  const colors = [0xd1f64b, 0xcbb065, 0xa7b8d9]
  for (let i = 0; i < count; i++) confetti.setColorAt(i, new THREE.Color(colors[i % 3]))
  confetti.userData.animate = (time, progress = 1) => {
    for (let i = 0; i < count; i++) {
      const x = Math.sin(i * 47.17) * 2.8
      const y = ((i * 0.79 - time * 0.19) % 4.8 + 4.8) % 4.8 - 1.2
      dummy.position.set(x, y, -0.8 + Math.cos(i * 11.8) * 1.6)
      dummy.rotation.set(i + time * 0.35, i * 2 + time * 0.23, i * 0.7)
      dummy.scale.setScalar(progress)
      dummy.updateMatrix()
      confetti.setMatrixAt(i, dummy.matrix)
    }
    confetti.instanceMatrix.needsUpdate = true
  }
  confetti.userData.animate(0)
  return confetti
}
