export interface UserProfile {
  id: string
  name: string
  createdAt: string
  lastSyncedAt: string | null
}

export interface CloudSyncPayload<StudyEntry, PhotoStudyItem> {
  profile: UserProfile
  studyHistory: StudyEntry[]
  photoStudies: PhotoStudyItem[]
  updatedAt: string
}

export interface CloudSyncResult<StudyEntry, PhotoStudyItem> {
  ok: boolean
  configured: boolean
  message: string
  payload?: CloudSyncPayload<StudyEntry, PhotoStudyItem>
}

const PROFILES_STORAGE_KEY = 'chess-tips-user-profiles-v1'
const ACTIVE_PROFILE_STORAGE_KEY = 'chess-tips-active-profile-v1'

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const readJson = <T,>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') {
    return fallback
  }

  try {
    const rawValue = window.localStorage.getItem(key)
    if (!rawValue) {
      return fallback
    }
    return JSON.parse(rawValue) as T
  } catch {
    return fallback
  }
}

const writeJson = (key: string, value: unknown): void => {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage write errors.
  }
}

export const createUserProfile = (name: string): UserProfile => ({
  id: makeId(),
  name,
  createdAt: new Date().toISOString(),
  lastSyncedAt: null,
})

export const ensureProfiles = (profiles: UserProfile[]): UserProfile[] =>
  profiles.length > 0 ? profiles : [createUserProfile('Learner 1')]

export const loadProfiles = (): UserProfile[] => {
  const profiles = readJson<UserProfile[]>(PROFILES_STORAGE_KEY, [])
  return ensureProfiles(Array.isArray(profiles) ? profiles : [])
}

export const saveProfiles = (profiles: UserProfile[]): void => {
  writeJson(PROFILES_STORAGE_KEY, ensureProfiles(profiles))
}

export const loadActiveProfileId = (): string | null =>
  readJson<string | null>(ACTIVE_PROFILE_STORAGE_KEY, null)

export const saveActiveProfileId = (profileId: string): void => {
  writeJson(ACTIVE_PROFILE_STORAGE_KEY, profileId)
}

export const buildScopedStorageKey = (
  baseKey: string,
  profileId: string,
): string => `${baseKey}:${profileId}`

const getCloudConfig = () => {
  const endpoint = import.meta.env.VITE_CLOUD_SYNC_ENDPOINT as string | undefined
  const token = import.meta.env.VITE_CLOUD_SYNC_TOKEN as string | undefined
  return {
    endpoint: endpoint?.trim() || null,
    token: token?.trim() || null,
  }
}

export const pushProfileToCloud = async <StudyEntry, PhotoStudyItem>(
  payload: CloudSyncPayload<StudyEntry, PhotoStudyItem>,
): Promise<CloudSyncResult<StudyEntry, PhotoStudyItem>> => {
  const config = getCloudConfig()
  if (!config.endpoint) {
    return {
      ok: false,
      configured: false,
      message:
        'Cloud sync endpoint is not configured. Set VITE_CLOUD_SYNC_ENDPOINT to enable remote sync.',
    }
  }

  const target = `${config.endpoint.replace(/\/$/, '')}/profiles/${payload.profile.id}`

  const response = await fetch(target, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    return {
      ok: false,
      configured: true,
      message: `Cloud sync failed with status ${response.status}.`,
    }
  }

  return {
    ok: true,
    configured: true,
    message: 'Profile pushed to cloud successfully.',
  }
}

export const pullProfileFromCloud = async <StudyEntry, PhotoStudyItem>(
  profileId: string,
): Promise<CloudSyncResult<StudyEntry, PhotoStudyItem>> => {
  const config = getCloudConfig()
  if (!config.endpoint) {
    return {
      ok: false,
      configured: false,
      message:
        'Cloud sync endpoint is not configured. Set VITE_CLOUD_SYNC_ENDPOINT to enable remote sync.',
    }
  }

  const target = `${config.endpoint.replace(/\/$/, '')}/profiles/${profileId}`

  const response = await fetch(target, {
    method: 'GET',
    headers: {
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
  })

  if (!response.ok) {
    return {
      ok: false,
      configured: true,
      message: `Cloud pull failed with status ${response.status}.`,
    }
  }

  const payload = (await response.json()) as CloudSyncPayload<StudyEntry, PhotoStudyItem>
  return {
    ok: true,
    configured: true,
    message: 'Profile pulled from cloud successfully.',
    payload,
  }
}
