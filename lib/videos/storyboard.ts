export interface StoryboardPlan {
  intervalSeconds: number
  columns: number
  rows: number
  frameWidth: number
  frameHeight: number
  frameCount: number
}

function even(value: number) {
  return Math.max(2, Math.round(value / 2) * 2)
}

export function buildStoryboardPlan(args: {
  durationSeconds: number | null
  width: number | null
  height: number | null
  maxFrames?: number
  frameWidth?: number
  columns?: number
}): StoryboardPlan | null {
  const durationSeconds = Number(args.durationSeconds || 0)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null

  const maxFrames = Math.max(12, Math.min(240, Math.round(args.maxFrames || 120)))
  const frameWidth = Math.max(120, Math.min(480, Math.round(args.frameWidth || 240)))
  const columns = Math.max(3, Math.min(10, Math.round(args.columns || 5)))
  const intervalSeconds = Math.max(5, Math.ceil(durationSeconds / maxFrames))
  const frameCount = Math.max(1, Math.min(maxFrames, Math.floor(durationSeconds / intervalSeconds) + 1))
  const aspect = args.width && args.height ? args.height / args.width : 9 / 16
  const frameHeight = even(frameWidth * aspect)

  return {
    intervalSeconds,
    columns,
    rows: Math.ceil(frameCount / columns),
    frameWidth,
    frameHeight,
    frameCount,
  }
}

export function storyboardFrameIndex(timeSeconds: number, plan: Pick<StoryboardPlan, 'intervalSeconds' | 'frameCount'>) {
  const rawIndex = Math.floor(Math.max(0, timeSeconds) / Math.max(1, plan.intervalSeconds))
  return Math.max(0, Math.min(Math.max(0, plan.frameCount - 1), rawIndex))
}
