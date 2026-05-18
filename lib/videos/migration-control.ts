import fs from 'node:fs'
import path from 'node:path'

type VideoMigrationControl = {
  notificationsPaused: boolean
  updatedAt?: string
  updatedBy?: string | null
  reason?: string | null
}

const CONTROL_FILE = path.join(process.cwd(), 'data', 'video-migration-control.json')

function readControl(): VideoMigrationControl {
  try {
    if (fs.existsSync(CONTROL_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'))
      return {
        notificationsPaused: Boolean(parsed?.notificationsPaused),
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : undefined,
        updatedBy: typeof parsed?.updatedBy === 'string' ? parsed.updatedBy : null,
        reason: typeof parsed?.reason === 'string' ? parsed.reason : null,
      }
    }
  } catch {
    /* Controle ausente ou invalido: mantem notificacoes ativas. */
  }

  return { notificationsPaused: false }
}

function writeControl(state: VideoMigrationControl) {
  try {
    fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true })
    fs.writeFileSync(CONTROL_FILE, JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[video-migration-control] nao consegui salvar controle:', message)
  }
}

export function pauseVideoMigrationNotifications(updatedBy = 'admin', reason = 'manual') {
  writeControl({
    notificationsPaused: true,
    updatedAt: new Date().toISOString(),
    updatedBy,
    reason,
  })
}

export function resumeVideoMigrationNotifications(updatedBy = 'admin') {
  writeControl({
    notificationsPaused: false,
    updatedAt: new Date().toISOString(),
    updatedBy,
    reason: null,
  })
}

export function isVideoMigrationNotificationPaused() {
  return readControl().notificationsPaused
}

export function getVideoMigrationNotificationControl() {
  return readControl()
}
