import { KITS, createPlayer } from '../player'
import {
  PoseBlender,
  clipCelebrate,
  clipDejected,
  clipMove,
  clipReady,
  clipSplitStep,
  clipStroke,
  clipWalk,
  headTrack,
} from '../strokes'

// Actor interface consumed by the director:
//   group       — root Object3D (director drives position/rotation.y)
//   update(dt, ctx) — ctx: { mode, time, idlePhase, stateKey, phase, type,
//                            t01, speed01, gait, lateralSign, ballPos, trackWeight }

const PLAYER_SCALE = 1.12

export function createPrimitiveActor(kitIndex) {
  const rig = createPlayer(kitIndex === 0 ? KITS.a : KITS.b)
  rig.group.scale.setScalar(PLAYER_SCALE)
  const blender = new PoseBlender(rig)

  return {
    group: rig.group,
    update(dt, ctx) {
      let pose
      switch (ctx.mode) {
        case 'stroke':
          pose = clipStroke(ctx.type, ctx.phase)
          break
        case 'split':
          pose = clipSplitStep(ctx.t01)
          break
        case 'move':
          pose = clipMove(ctx.time + ctx.idlePhase, ctx.speed01, ctx.gait, ctx.lateralSign)
          break
        case 'celebrate':
          pose = clipCelebrate(ctx.time)
          break
        case 'dejected':
          pose = clipDejected(ctx.time + ctx.idlePhase)
          break
        case 'walk':
          pose = clipWalk(ctx.time + ctx.idlePhase, ctx.speed01)
          break
        default:
          pose = clipReady(ctx.time + ctx.idlePhase)
      }
      blender.setState(ctx.stateKey)
      blender.apply(pose, dt)
      if (ctx.ballPos && ctx.trackWeight > 0) {
        headTrack(blender, ctx.ballPos, dt, ctx.trackWeight)
      }
    },
  }
}
