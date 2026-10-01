import type { Color } from 'chess.js'

type FenshotModule = {
  createRecognizer: (options: {
    modelUrl: string
    wasmPaths: string
  }) => {
    recognize: (source: File | Blob | HTMLImageElement | ImageBitmap) => Promise<{
      placement: unknown
      reliable?: boolean
    } | null>
  }
  resolveOrientation: (placement: unknown) => {
    placement: unknown
    orientation: string | number
  }
  placementToFen: (placement: unknown, turn: Color) => string
}

export interface BoardRecognitionResult {
  status: 'ok' | 'low-confidence' | 'no-board' | 'error'
  fen: string | null
  reliable: boolean
  orientation: string | null
  message: string
}

const FENSHOT_MODULE_URL = 'https://esm.sh/@scoriiu/fenshot@0.1.4'
const FENSHOT_MODEL_URL =
  'https://cdn.jsdelivr.net/npm/@scoriiu/fenshot@0.1.4/model/chess-tiles-v2.onnx'
const ORT_WASM_BASE_URL =
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/'

let recognizerPromise:
  | Promise<{
      module: FenshotModule
      recognizer: {
        recognize: (
          source: File | Blob | HTMLImageElement | ImageBitmap,
        ) => Promise<{
          placement: unknown
          reliable?: boolean
        } | null>
      }
    }>
  | null = null

const getRecognizer = async () => {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      const module = (await import(
        /* @vite-ignore */ FENSHOT_MODULE_URL
      )) as unknown as FenshotModule

      const recognizer = module.createRecognizer({
        modelUrl: FENSHOT_MODEL_URL,
        wasmPaths: ORT_WASM_BASE_URL,
      })

      return { module, recognizer }
    })()
  }

  return recognizerPromise
}

const normalizeOrientation = (orientation: string | number): string => {
  const raw = String(orientation).toLowerCase()
  if (raw.includes('black') || raw === '-1') {
    return 'black-bottom'
  }
  if (raw.includes('white') || raw === '1') {
    return 'white-bottom'
  }
  return raw
}

interface FenStats {
  whiteKings: number
  blackKings: number
  whitePawns: number
  blackPawns: number
  whitePieces: number
  blackPieces: number
  totalPieces: number
}

const collectFenStats = (fen: string): FenStats | null => {
  const board = fen.split(' ')[0]
  const ranks = board.split('/')
  if (ranks.length !== 8) {
    return null
  }

  const stats: FenStats = {
    whiteKings: 0,
    blackKings: 0,
    whitePawns: 0,
    blackPawns: 0,
    whitePieces: 0,
    blackPieces: 0,
    totalPieces: 0,
  }

  for (const rank of ranks) {
    let fileCount = 0

    for (const char of rank) {
      if (char >= '1' && char <= '8') {
        fileCount += Number(char)
        continue
      }

      const isWhite = char >= 'A' && char <= 'Z'
      const isBlack = char >= 'a' && char <= 'z'
      if (!isWhite && !isBlack) {
        return null
      }

      fileCount += 1
      stats.totalPieces += 1

      if (isWhite) {
        stats.whitePieces += 1
        if (char === 'K') {
          stats.whiteKings += 1
        }
        if (char === 'P') {
          stats.whitePawns += 1
        }
      } else {
        stats.blackPieces += 1
        if (char === 'k') {
          stats.blackKings += 1
        }
        if (char === 'p') {
          stats.blackPawns += 1
        }
      }
    }

    if (fileCount !== 8) {
      return null
    }
  }

  return stats
}

const fenLooksPlausible = (fen: string): boolean => {
  const stats = collectFenStats(fen)
  if (!stats) {
    return false
  }

  if (stats.whiteKings !== 1 || stats.blackKings !== 1) {
    return false
  }

  if (stats.whitePawns > 8 || stats.blackPawns > 8) {
    return false
  }

  if (stats.whitePieces > 16 || stats.blackPieces > 16) {
    return false
  }

  return stats.totalPieces >= 2 && stats.totalPieces <= 32
}

export const warmupBoardRecognizer = async (): Promise<void> => {
  await getRecognizer()
}

export const detectFenFromImage = async (
  source: File | Blob | HTMLImageElement | ImageBitmap,
  turn: Color = 'w',
): Promise<BoardRecognitionResult> => {
  try {
    const { module, recognizer } = await getRecognizer()
    const result = await recognizer.recognize(source)

    if (!result) {
      return {
        status: 'no-board',
        fen: null,
        reliable: false,
        orientation: null,
        message:
          'No board was detected. Use a straight 2D screenshot where the board is fully visible.',
      }
    }

    const { placement, orientation } = module.resolveOrientation(result.placement)
    const fen = module.placementToFen(placement, turn)
    const plausibleFen = fenLooksPlausible(fen)
    const reliable = result.reliable !== false

    if (!plausibleFen) {
      return {
        status: 'no-board',
        fen: null,
        reliable: false,
        orientation: null,
        message:
          'Detected layout did not resemble a valid chess position. Try a clearer, straighter board image.',
      }
    }

    return {
      status: reliable ? 'ok' : 'low-confidence',
      fen,
      reliable,
      orientation: normalizeOrientation(orientation),
      message: reliable
        ? 'Board recognized successfully.'
        : 'Board recognized with low confidence. Review the detected FEN before loading it.',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown recognition error'
    return {
      status: 'error',
      fen: null,
      reliable: false,
      orientation: null,
      message: `Board recognition failed: ${message}`,
    }
  }
}
