import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react'
import { Chess, validateFen, type PieceSymbol, type Square } from 'chess.js'
import { analyzePosition, colorName, type MoveAdvice } from './lib/chessCoach'
import {
  analyzeWithStockfish,
  formatStockfishScore,
  scoreFromLine,
  type StockfishLine,
} from './lib/stockfishWorker'
import {
  detectFenFromImage,
  warmupBoardRecognizer,
  type BoardRecognitionResult,
} from './lib/boardRecognition'
import {
  buildScopedStorageKey,
  createUserProfile,
  ensureProfiles,
  loadActiveProfileId,
  loadProfiles,
  pullProfileFromCloud,
  pushProfileToCloud,
  saveActiveProfileId,
  saveProfiles,
  type UserProfile,
} from './lib/profileSync'
import './App.css'

const START_FEN = new Chess().fen()
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const

const HISTORY_STORAGE_BASE_KEY = 'chess-tips-study-history-v2'
const PHOTO_STORAGE_BASE_KEY = 'chess-tips-photo-study-v2'
const MAX_STUDY_ENTRIES = 80
const MAX_PHOTO_STUDIES = 18
const MAX_PHOTO_BYTES = 2_500_000
const MAX_PV_MOVES_TO_SHOW = 6

type EngineSource = 'heuristic' | 'stockfish'
type Side = 'w' | 'b'
type AppScreen = 'board' | 'coach' | 'study' | 'learn'
type DetectionStatus = BoardRecognitionResult['status']

interface StudyEntry {
  id: string
  timestamp: string
  fen: string
  sideToMove: Side
  moveInput: string
  moveSan: string
  quality: string
  scoreLabel: string
  loss: number
  warning: string | null
  comparison: string | null
}

interface PhotoStudyItem {
  id: string
  fileName: string
  createdAt: string
  linkedFen: string
  previewDataUrl: string
}

interface StockfishMoveAdvice extends MoveAdvice {
  pvPreview: string
}

interface CandidateReviewResult {
  candidateMove: MoveAdvice | null
  candidateComparison: string | null
  candidateError: string | null
  source: EngineSource
}

const APP_SCREEN_HASHES: Record<AppScreen, string> = {
  board: '#/board',
  coach: '#/coach',
  study: '#/study',
  learn: '#/learn',
}

const APP_SCREEN_MENU: Array<{ id: AppScreen; label: string; caption: string }> = [
  { id: 'board', label: 'Board', caption: 'Play moves and edit positions' },
  { id: 'coach', label: 'Coach', caption: 'Analyze lines and grade ideas' },
  { id: 'study', label: 'Study', caption: 'History, profiles, and uploads' },
  { id: 'learn', label: 'Learn', caption: 'Roadmaps and next formats' },
]

const LEARNING_TRACKS = [
  {
    level: 'Beginner',
    target: 'Rules, board vision, and confidence',
    outcomes: [
      'Understand how every piece moves and trades value.',
      'Spot one-move threats before making your move.',
      'Practice check, checkmate, and basic mating patterns.',
    ],
  },
  {
    level: 'Intermediate',
    target: 'Tactics and positional planning',
    outcomes: [
      'Train forks, pins, skewers, and discovered attacks.',
      'Evaluate candidate moves with short tactical calculations.',
      'Build opening principles without memorizing endless lines.',
    ],
  },
  {
    level: 'Advanced',
    target: 'Conversion and deep understanding',
    outcomes: [
      'Convert advantages with strategic plans and endgame technique.',
      'Review mistakes by category and trend over time.',
      'Prepare opening repertoires with explanation, not only moves.',
    ],
  },
] as const

const EXPANSION_MODES = [
  {
    title: 'Photo To Position',
    text: 'Auto-recognition is active for straight screenshots and diagrams; use detected FEN to load quickly.',
  },
  {
    title: 'Video Breakdown',
    text: 'Analyze key moments from uploaded game clips and explain turning points in plain language.',
  },
  {
    title: 'Live Coach Mode',
    text: 'Connect to a live game stream and get candidate moves with proactive warning prompts.',
  },
] as const

const PIECE_WORDS: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
}

const PIECE_GLYPHS: Record<'w' | 'b', Record<PieceSymbol, string>> = {
  w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
  b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' },
}

const parseAppScreenFromHash = (hash: string): AppScreen => {
  const normalized = hash.replace(/^#\/?/, '').trim().toLowerCase()
  if (normalized === 'coach') return 'coach'
  if (normalized === 'study') return 'study'
  if (normalized === 'learn') return 'learn'
  return 'board'
}

const qualityTone = (quality: string): string => {
  if (quality === 'Best' || quality === 'Strong') return 'quality-positive'
  if (quality === 'Playable') return 'quality-neutral'
  return 'quality-warning'
}

const qualityFromLoss = (loss: number): string => {
  if (loss <= 20) return 'Best'
  if (loss <= 80) return 'Strong'
  if (loss <= 180) return 'Playable'
  if (loss <= 320) return 'Inaccuracy'
  if (loss <= 500) return 'Mistake'
  return 'Blunder'
}

const formatCpLabel = (score: number): string => {
  const pawns = score / 100
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
}

const makeId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const safeArrayFromStorage = <T,>(key: string): T[] => {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

const saveArrayToStorage = (key: string, value: unknown[]): void => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore quota/private mode errors.
  }
}

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('Could not read file.'))
    }
    reader.onerror = () => reject(new Error('File read failed.'))
    reader.readAsDataURL(file)
  })

const formatDateTime = (isoDate: string): string => {
  const date = new Date(isoDate)
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

const parseUciMove = (
  uci: string,
): { from: Square; to: Square; promotion?: PieceSymbol } | null => {
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(uci.trim())
  if (!match) return null
  const [, from, to, promotion] = match
  return {
    from: from.toLowerCase() as Square,
    to: to.toLowerCase() as Square,
    promotion: promotion?.toLowerCase() as PieceSymbol | undefined,
  }
}

const toSanFromUci = (fen: string, uciMove: string): string => {
  const parsed = parseUciMove(uciMove)
  if (!parsed) return uciMove

  try {
    const chess = new Chess(fen)
    const move = chess.move(parsed, { strict: false })
    return move.san
  } catch {
    return uciMove
  }
}

const toSanSequence = (fen: string, pv: string[]): string[] => {
  const chess = new Chess(fen)
  const sanMoves: string[] = []

  for (const uciMove of pv.slice(0, MAX_PV_MOVES_TO_SHOW)) {
    const parsed = parseUciMove(uciMove)
    if (!parsed) break

    try {
      const move = chess.move(parsed, { strict: false })
      sanMoves.push(move.san)
    } catch {
      break
    }
  }

  return sanMoves
}

const stockfishLinesToAdvice = (
  fen: string,
  lines: StockfishLine[],
): StockfishMoveAdvice[] => {
  if (lines.length === 0) return []

  const sorted = [...lines].sort((left, right) => left.multipv - right.multipv)
  const bestScore = scoreFromLine(sorted[0])

  return sorted.map((line) => {
    const score = scoreFromLine(line)
    const loss = Math.max(0, bestScore - score)
    const quality = qualityFromLoss(loss)
    const san = toSanFromUci(fen, line.uci)
    const pvSan = toSanSequence(fen, line.pv)

    return {
      san,
      uci: line.uci,
      score,
      scoreLabel: formatStockfishScore(line),
      loss,
      quality,
      explanation:
        pvSan.length > 0
          ? `Stockfish principal variation: ${pvSan.join(' ')}`
          : 'Stockfish selected this move from engine search.',
      warnings:
        quality === 'Mistake' || quality === 'Blunder'
          ? ['This move is significantly weaker than the top engine line.']
          : [],
      bestReply: line.pv[1] ?? null,
      pvPreview: pvSan.join(' '),
    }
  })
}

const parseCandidateMoveInput = (
  fen: string,
  rawMove: string,
):
  | {
      moveSan: string
      moveUci: string
      afterFen: string
    }
  | { error: string } => {
  const cleanMove = rawMove.trim()
  if (!cleanMove) {
    return { error: 'Enter a move like e4, Nf3, or e2e4 to get feedback.' }
  }

  const draft = new Chess(fen)

  try {
    const uciParsed = parseUciMove(cleanMove)
    const move = uciParsed
      ? draft.move(uciParsed, { strict: false })
      : draft.move(cleanMove, { strict: false })

    return {
      moveSan: move.san,
      moveUci: `${move.from}${move.to}${move.promotion ?? ''}`,
      afterFen: draft.fen(),
    }
  } catch {
    return { error: 'That move is not legal in this exact position.' }
  }
}

const initialProfiles = ensureProfiles(loadProfiles())
const initialActiveProfileId =
  loadActiveProfileId() ?? initialProfiles[0]?.id ?? createUserProfile('Learner 1').id

function App() {
  const [activeScreen, setActiveScreen] = useState<AppScreen>(() =>
    typeof window === 'undefined' ? 'board' : parseAppScreenFromHash(window.location.hash),
  )

  const [fen, setFen] = useState(START_FEN)
  const [fenDraft, setFenDraft] = useState(START_FEN)
  const [engineSource, setEngineSource] = useState<EngineSource>('heuristic')
  const [analysisDepth, setAnalysisDepth] = useState(2)
  const [topLineCount, setTopLineCount] = useState(3)
  const [stockfishDepth, setStockfishDepth] = useState(12)
  const [stockfishLines, setStockfishLines] = useState<StockfishLine[]>([])
  const [stockfishMessage, setStockfishMessage] = useState<string | null>(null)
  const [stockfishError, setStockfishError] = useState<string | null>(null)
  const [stockfishFen, setStockfishFen] = useState<string | null>(null)
  const [isRunningStockfish, setIsRunningStockfish] = useState(false)
  const [isGradingCandidateWithStockfish, setIsGradingCandidateWithStockfish] =
    useState(false)
  const [stockfishCandidateReview, setStockfishCandidateReview] =
    useState<CandidateReviewResult | null>(null)

  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null)
  const [candidateDraft, setCandidateDraft] = useState('')
  const [submittedCandidate, setSubmittedCandidate] = useState('')
  const [positionMessage, setPositionMessage] = useState<string | null>(null)

  const [imageMessage, setImageMessage] = useState<string | null>(null)
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false)
  const [isDetectingFen, setIsDetectingFen] = useState(false)
  const [detectedFenDraft, setDetectedFenDraft] = useState<string | null>(null)
  const [detectedOrientation, setDetectedOrientation] = useState<string | null>(null)
  const [detectedStatus, setDetectedStatus] = useState<DetectionStatus | null>(null)
  const [detectedFenEditorDraft, setDetectedFenEditorDraft] = useState('')
  const [showDetectionEditor, setShowDetectionEditor] = useState(false)
  const [detectedFenReviewed, setDetectedFenReviewed] = useState(false)
  const [detectedFenEditorMessage, setDetectedFenEditorMessage] =
    useState<string | null>(null)
  const [detectTurn, setDetectTurn] = useState<Side>('w')

  const [profiles, setProfiles] = useState<UserProfile[]>(initialProfiles)
  const [activeProfileId, setActiveProfileId] = useState(initialActiveProfileId)
  const [newProfileName, setNewProfileName] = useState('')
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const [studyHistory, setStudyHistory] = useState<StudyEntry[]>(() =>
    safeArrayFromStorage<StudyEntry>(
      buildScopedStorageKey(HISTORY_STORAGE_BASE_KEY, initialActiveProfileId),
    ),
  )
  const [photoStudies, setPhotoStudies] = useState<PhotoStudyItem[]>(() =>
    safeArrayFromStorage<PhotoStudyItem>(
      buildScopedStorageKey(PHOTO_STORAGE_BASE_KEY, initialActiveProfileId),
    ),
  )

  useEffect(() => {
    if (typeof window === 'undefined') return

    const syncScreenFromHash = () => {
      setActiveScreen(parseAppScreenFromHash(window.location.hash))
    }

    syncScreenFromHash()
    window.addEventListener('hashchange', syncScreenFromHash)
    return () => window.removeEventListener('hashchange', syncScreenFromHash)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const expectedHash = APP_SCREEN_HASHES[activeScreen]
    if (window.location.hash !== expectedHash) {
      window.history.replaceState(null, '', expectedHash)
    }
  }, [activeScreen])

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0],
    [profiles, activeProfileId],
  )

  const scopedHistoryKey = buildScopedStorageKey(HISTORY_STORAGE_BASE_KEY, activeProfile.id)
  const scopedPhotoKey = buildScopedStorageKey(PHOTO_STORAGE_BASE_KEY, activeProfile.id)

  const chess = useMemo(() => new Chess(fen), [fen])
  const board = chess.board()

  const analysisOptions = useMemo(
    () => ({ depth: analysisDepth, topMovesCount: topLineCount }),
    [analysisDepth, topLineCount],
  )

  const positionAnalysis = useMemo(
    () => analyzePosition(fen, undefined, analysisOptions),
    [fen, analysisOptions],
  )

  const heuristicCandidateAnalysis = useMemo(
    () =>
      submittedCandidate.length > 0
        ? analyzePosition(fen, submittedCandidate, analysisOptions)
        : null,
    [fen, submittedCandidate, analysisOptions],
  )

  const stockfishAdvice = useMemo(
    () => (stockfishFen === fen ? stockfishLinesToAdvice(fen, stockfishLines) : []),
    [fen, stockfishFen, stockfishLines],
  )

  const activeTopMoves =
    engineSource === 'stockfish' && stockfishAdvice.length > 0
      ? stockfishAdvice
      : positionAnalysis.topMoves

  const bestMove = activeTopMoves[0] ?? null

  const activeCandidateReview: CandidateReviewResult | null =
    engineSource === 'stockfish'
      ? stockfishCandidateReview
      : heuristicCandidateAnalysis
        ? {
            candidateMove: heuristicCandidateAnalysis.candidateMove,
            candidateComparison: heuristicCandidateAnalysis.candidateComparison,
            candidateError: heuristicCandidateAnalysis.candidateError,
            source: 'heuristic',
          }
        : null

  const detectionNeedsReview =
    detectedStatus === 'low-confidence' && !detectedFenReviewed

  const legalTargets = useMemo(() => {
    if (!selectedSquare) return new Set<Square>()
    const candidateMoves = chess.moves({ square: selectedSquare, verbose: true })
    return new Set(candidateMoves.map((move) => move.to))
  }, [chess, selectedSquare])

  const lastMove = useMemo(() => {
    const history = chess.history({ verbose: true })
    return history.at(-1) ?? null
  }, [chess])

  const checkedKingSquare = useMemo(() => {
    if (!chess.isCheck()) return null

    for (const row of board) {
      for (const squarePiece of row) {
        if (squarePiece && squarePiece.type === 'k' && squarePiece.color === chess.turn()) {
          return squarePiece.square
        }
      }
    }

    return null
  }, [board, chess])

  const statusLine = useMemo(() => {
    if (chess.isCheckmate()) {
      return `Checkmate. ${colorName(chess.turn() === 'w' ? 'b' : 'w')} wins.`
    }
    if (chess.isDraw()) return 'Drawn position.'
    if (chess.isCheck()) return `${colorName(chess.turn())} to move and currently in check.`
    return `${colorName(chess.turn())} to move.`
  }, [chess])

  const stockfishIsStale =
    engineSource === 'stockfish' && stockfishFen !== null && stockfishFen !== fen

  const activeEngineLabel =
    engineSource === 'stockfish' ? `Stockfish depth ${stockfishDepth}` : positionAnalysis.engineLabel

  const activeSummary =
    engineSource === 'stockfish' && stockfishAdvice.length > 0
      ? `Stockfish top line: ${stockfishAdvice[0].san} (${stockfishAdvice[0].scoreLabel}).`
      : positionAnalysis.summary

  const historySummary = useMemo(() => {
    const summary = { bestStrong: 0, playable: 0, mistakes: 0 }
    const warningCounts = new Map<string, number>()

    for (const item of studyHistory) {
      if (item.quality === 'Best' || item.quality === 'Strong') summary.bestStrong += 1
      else if (item.quality === 'Playable' || item.quality === 'Inaccuracy') summary.playable += 1
      else summary.mistakes += 1

      if (item.warning) {
        warningCounts.set(item.warning, (warningCounts.get(item.warning) ?? 0) + 1)
      }
    }

    let topWarning: string | null = null
    let maxCount = 0
    for (const [warning, count] of warningCounts) {
      if (count > maxCount) {
        maxCount = count
        topWarning = warning
      }
    }

    return {
      ...summary,
      total: studyHistory.length,
      topWarning,
    }
  }, [studyHistory])

  const navigateToScreen = (screen: AppScreen) => {
    setActiveScreen(screen)
  }

  const persistStudyHistory = (nextHistory: StudyEntry[]) => {
    setStudyHistory(nextHistory)
    saveArrayToStorage(scopedHistoryKey, nextHistory)
  }

  const persistPhotoStudies = (nextPhotos: PhotoStudyItem[]) => {
    setPhotoStudies(nextPhotos)
    saveArrayToStorage(scopedPhotoKey, nextPhotos)
  }

  const persistProfiles = (nextProfiles: UserProfile[]) => {
    const ensuredProfiles = ensureProfiles(nextProfiles)
    setProfiles(ensuredProfiles)
    saveProfiles(ensuredProfiles)
  }

  const clearScreenStates = () => {
    setStockfishLines([])
    setStockfishFen(null)
    setStockfishCandidateReview(null)
    setDetectedFenDraft(null)
    setDetectedStatus(null)
    setDetectedFenEditorDraft('')
    setDetectedFenReviewed(false)
    setShowDetectionEditor(false)
    setDetectedFenEditorMessage(null)
  }

  const switchActiveProfile = (profileId: string) => {
    const profile = profiles.find((item) => item.id === profileId)
    if (!profile) return

    setActiveProfileId(profileId)
    saveActiveProfileId(profileId)
    setStudyHistory(
      safeArrayFromStorage<StudyEntry>(buildScopedStorageKey(HISTORY_STORAGE_BASE_KEY, profileId)),
    )
    setPhotoStudies(
      safeArrayFromStorage<PhotoStudyItem>(buildScopedStorageKey(PHOTO_STORAGE_BASE_KEY, profileId)),
    )
    clearScreenStates()
    setSyncMessage(`Switched to profile ${profile.name}.`)
  }

  const createProfile = () => {
    const trimmedName = newProfileName.trim()
    if (!trimmedName) {
      setSyncMessage('Enter a profile name first.')
      return
    }

    const nextProfile = createUserProfile(trimmedName)
    const nextProfiles = [...profiles, nextProfile]
    persistProfiles(nextProfiles)
    setNewProfileName('')
    setActiveProfileId(nextProfile.id)
    saveActiveProfileId(nextProfile.id)
    setStudyHistory([])
    setPhotoStudies([])
    clearScreenStates()
    setSyncMessage(`Created profile ${nextProfile.name}.`)
  }

  const pushCloudSync = async () => {
    setIsSyncing(true)
    try {
      const result = await pushProfileToCloud<StudyEntry, PhotoStudyItem>({
        profile: activeProfile,
        studyHistory,
        photoStudies,
        updatedAt: new Date().toISOString(),
      })

      if (result.ok) {
        const updatedProfiles = profiles.map((profile) =>
          profile.id === activeProfile.id
            ? { ...profile, lastSyncedAt: new Date().toISOString() }
            : profile,
        )
        persistProfiles(updatedProfiles)
      }

      setSyncMessage(result.message)
    } catch {
      setSyncMessage('Cloud push failed because the sync endpoint could not be reached.')
    } finally {
      setIsSyncing(false)
    }
  }

  const pullCloudSync = async () => {
    setIsSyncing(true)
    try {
      const result = await pullProfileFromCloud<StudyEntry, PhotoStudyItem>(activeProfile.id)

      if (result.ok && result.payload) {
        const pulledHistory = Array.isArray(result.payload.studyHistory)
          ? result.payload.studyHistory
          : []
        const pulledPhotos = Array.isArray(result.payload.photoStudies)
          ? result.payload.photoStudies
          : []

        persistStudyHistory(pulledHistory)
        persistPhotoStudies(pulledPhotos)

        const updatedProfiles = profiles.map((profile) =>
          profile.id === activeProfile.id
            ? { ...profile, lastSyncedAt: new Date().toISOString() }
            : profile,
        )
        persistProfiles(updatedProfiles)
      }

      setSyncMessage(result.message)
    } catch {
      setSyncMessage('Cloud pull failed because the sync endpoint could not be reached.')
    } finally {
      setIsSyncing(false)
    }
  }

  const applyFenPosition = (nextFen: string, message: string) => {
    const validation = validateFen(nextFen)
    if (!validation.ok) {
      setPositionMessage(validation.error ?? 'Invalid FEN string.')
      return
    }

    setFen(nextFen)
    setFenDraft(nextFen)
    setSelectedSquare(null)
    setSubmittedCandidate('')
    setStockfishCandidateReview(null)
    setPositionMessage(message)
  }

  const runStockfishAnalysis = async () => {
    setIsRunningStockfish(true)
    setStockfishError(null)
    setStockfishMessage(null)

    try {
      const report = await analyzeWithStockfish(fen, {
        depth: stockfishDepth,
        multiPv: topLineCount,
      })

      setStockfishLines(report.lines)
      setStockfishFen(fen)
      setStockfishMessage(`Stockfish complete (${report.source}) at depth ${report.depth}.`)
      setEngineSource('stockfish')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not run Stockfish analysis.'
      setStockfishError(message)
      setEngineSource('heuristic')
    } finally {
      setIsRunningStockfish(false)
    }
  }

  const playMove = (from: Square, to: Square, promotion?: PieceSymbol) => {
    const draft = new Chess(fen)
    const movingPiece = draft.get(from)
    const fallbackPromotion =
      movingPiece?.type === 'p' && (to.endsWith('1') || to.endsWith('8')) ? 'q' : undefined

    try {
      const move = draft.move({ from, to, promotion: promotion ?? fallbackPromotion }, { strict: false })
      const nextFen = draft.fen()
      setFen(nextFen)
      setFenDraft(nextFen)
      setSelectedSquare(null)
      setSubmittedCandidate('')
      setStockfishCandidateReview(null)
      setPositionMessage(`Played ${move.san}.`)
    } catch {
      setPositionMessage('That move is not legal in this position.')
    }
  }

  const playSuggestedMove = (move: MoveAdvice) => {
    const parsed = parseUciMove(move.uci)
    if (!parsed) {
      setPositionMessage('Could not parse this suggestion into a legal board move.')
      return
    }

    playMove(parsed.from, parsed.to, parsed.promotion)
  }

  const onSquareClick = (square: Square) => {
    const clickedPiece = chess.get(square)

    if (selectedSquare) {
      if (selectedSquare === square) {
        setSelectedSquare(null)
        return
      }

      if (legalTargets.has(square)) {
        playMove(selectedSquare, square)
        return
      }

      if (clickedPiece && clickedPiece.color === chess.turn()) {
        setSelectedSquare(square)
        return
      }

      setSelectedSquare(null)
      return
    }

    if (clickedPiece && clickedPiece.color === chess.turn()) {
      setSelectedSquare(square)
    }
  }

  const loadFen = () => {
    const candidateFen = fenDraft.trim()
    const validation = validateFen(candidateFen)
    if (!validation.ok) {
      setPositionMessage(validation.error ?? 'Invalid FEN string.')
      return
    }

    setFen(candidateFen)
    setFenDraft(candidateFen)
    setSelectedSquare(null)
    setSubmittedCandidate('')
    setStockfishCandidateReview(null)
    setPositionMessage('Custom position loaded.')
  }

  const resetBoard = () => {
    setFen(START_FEN)
    setFenDraft(START_FEN)
    setSelectedSquare(null)
    setSubmittedCandidate('')
    setStockfishCandidateReview(null)
    setPositionMessage('Board reset to the starting position.')
  }

  const undoMove = () => {
    const draft = new Chess(fen)
    const undoneMove = draft.undo()

    if (!undoneMove) {
      setPositionMessage('No move to undo.')
      return
    }

    const nextFen = draft.fen()
    setFen(nextFen)
    setFenDraft(nextFen)
    setSelectedSquare(null)
    setSubmittedCandidate('')
    setStockfishCandidateReview(null)
    setPositionMessage(`Undid ${undoneMove.san}.`)
  }

  const submitCandidateMove = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const cleanMove = candidateDraft.trim()
    if (!cleanMove) {
      setPositionMessage('Enter a move like e4, Nf3, or e2e4 to get feedback.')
      return
    }

    setSubmittedCandidate(cleanMove)

    if (engineSource === 'stockfish') {
      setIsGradingCandidateWithStockfish(true)
      setStockfishError(null)

      try {
        const parsedCandidate = parseCandidateMoveInput(fen, cleanMove)
        if ('error' in parsedCandidate) {
          setStockfishCandidateReview({
            candidateMove: null,
            candidateComparison: null,
            candidateError: parsedCandidate.error,
            source: 'stockfish',
          })
          setPositionMessage(parsedCandidate.error)
          return
        }

        const rootReport = await analyzeWithStockfish(fen, {
          depth: stockfishDepth,
          multiPv: Math.max(topLineCount, 3),
        })
        const replyReport = await analyzeWithStockfish(parsedCandidate.afterFen, {
          depth: Math.max(stockfishDepth - 1, 8),
          multiPv: 1,
        })

        const bestLine = rootReport.lines[0] ?? null
        const bestScore = bestLine ? scoreFromLine(bestLine) : 0
        const replyLine = replyReport.lines[0] ?? null
        const candidateScore = replyLine ? -scoreFromLine(replyLine) : 0
        const loss = Math.max(0, bestScore - candidateScore)
        const quality = qualityFromLoss(loss)

        const replySanMoves = replyLine ? toSanSequence(parsedCandidate.afterFen, replyLine.pv) : []
        const bestSan = bestLine ? toSanFromUci(fen, bestLine.uci) : null
        const candidateMatchesTop = bestLine?.uci === parsedCandidate.moveUci

        const candidateMove: MoveAdvice = {
          san: parsedCandidate.moveSan,
          uci: parsedCandidate.moveUci,
          score: candidateScore,
          scoreLabel: formatCpLabel(candidateScore),
          loss,
          quality,
          explanation:
            replySanMoves.length > 0
              ? `Stockfish expects: ${replySanMoves.join(' ')}`
              : 'Stockfish could not provide a principal variation for this line yet.',
          warnings:
            quality === 'Mistake' || quality === 'Blunder'
              ? ['This move loses significant value against accurate defense.']
              : [],
          bestReply: replySanMoves[0] ?? null,
        }

        const comparison =
          bestSan === null
            ? null
            : candidateMatchesTop
              ? `This move matches Stockfish top line (${bestSan}) at depth ${stockfishDepth}.`
              : loss <= 20
                ? `This move is effectively tied with Stockfish top line (${bestSan}).`
                : `Compared with Stockfish top line ${bestSan}, this move drops about ${(loss / 100).toFixed(2)} pawns at depth ${stockfishDepth}.`

        setStockfishCandidateReview({
          candidateMove,
          candidateComparison: comparison,
          candidateError: null,
          source: 'stockfish',
        })

        const sideToMove = new Chess(fen).turn() as Side
        const newEntry: StudyEntry = {
          id: makeId(),
          timestamp: new Date().toISOString(),
          fen,
          sideToMove,
          moveInput: cleanMove,
          moveSan: candidateMove.san,
          quality: candidateMove.quality,
          scoreLabel: candidateMove.scoreLabel,
          loss: candidateMove.loss,
          warning: candidateMove.warnings[0] ?? null,
          comparison,
        }

        const nextHistory = [newEntry, ...studyHistory].slice(0, MAX_STUDY_ENTRIES)
        persistStudyHistory(nextHistory)
        setPositionMessage(`Saved Stockfish review: ${candidateMove.san} (${candidateMove.quality}).`)
      } catch (error) {
        const message =
          error instanceof Error
            ? `Stockfish candidate grading failed: ${error.message}`
            : 'Stockfish candidate grading failed.'
        setStockfishCandidateReview({
          candidateMove: null,
          candidateComparison: null,
          candidateError: message,
          source: 'stockfish',
        })
        setPositionMessage(message)
      } finally {
        setIsGradingCandidateWithStockfish(false)
      }

      return
    }

    setStockfishCandidateReview(null)

    const review = analyzePosition(fen, cleanMove, analysisOptions)
    if (review.candidateMove) {
      const newEntry: StudyEntry = {
        id: makeId(),
        timestamp: new Date().toISOString(),
        fen,
        sideToMove: review.turn as Side,
        moveInput: cleanMove,
        moveSan: review.candidateMove.san,
        quality: review.candidateMove.quality,
        scoreLabel: review.candidateMove.scoreLabel,
        loss: review.candidateMove.loss,
        warning: review.candidateMove.warnings[0] ?? null,
        comparison: review.candidateComparison,
      }

      const nextHistory = [newEntry, ...studyHistory].slice(0, MAX_STUDY_ENTRIES)
      persistStudyHistory(nextHistory)
      setPositionMessage(`Saved review: ${review.candidateMove.san} (${review.candidateMove.quality}).`)
    } else if (review.candidateError) {
      setPositionMessage(review.candidateError)
    }
  }

  const clearStudyHistory = () => {
    persistStudyHistory([])
    setPositionMessage('Progress tracker cleared.')
  }

  const removeHistoryItem = (id: string) => {
    const nextHistory = studyHistory.filter((item) => item.id !== id)
    persistStudyHistory(nextHistory)
  }

  const uploadPhotoStudy = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''

    if (!file) return

    if (!file.type.startsWith('image/')) {
      setImageMessage('Please upload an image file.')
      return
    }

    if (file.size > MAX_PHOTO_BYTES) {
      setImageMessage('Image too large. Keep files under 2.5 MB for smooth study storage.')
      return
    }

    setIsUploadingPhoto(true)
    try {
      await warmupBoardRecognizer()
      const previewDataUrl = await readFileAsDataUrl(file)
      const newItem: PhotoStudyItem = {
        id: makeId(),
        fileName: file.name,
        createdAt: new Date().toISOString(),
        linkedFen: fen,
        previewDataUrl,
      }

      const nextPhotos = [newItem, ...photoStudies].slice(0, MAX_PHOTO_STUDIES)
      persistPhotoStudies(nextPhotos)

      setIsDetectingFen(true)
      const recognition = await detectFenFromImage(file, detectTurn)
      setDetectedStatus(recognition.status)

      if (recognition.fen) {
        setDetectedFenDraft(recognition.fen)
        setDetectedFenEditorDraft(recognition.fen)
        setDetectedOrientation(recognition.orientation)

        if (recognition.status === 'low-confidence') {
          setDetectedFenReviewed(false)
          setShowDetectionEditor(true)
          setDetectedFenEditorMessage(
            'Confidence is low. Review and adjust this FEN before loading it onto the board.',
          )
        } else {
          setDetectedFenReviewed(true)
          setShowDetectionEditor(false)
          setDetectedFenEditorMessage(null)
        }
      } else {
        setDetectedFenDraft(null)
        setDetectedFenEditorDraft('')
        setDetectedOrientation(null)
        setDetectedFenReviewed(false)
        setShowDetectionEditor(false)
        setDetectedFenEditorMessage(null)
      }

      setImageMessage(`Photo saved and linked to the current position. ${recognition.message}`)
    } catch {
      setImageMessage('Could not process this image. Try a different file.')
    } finally {
      setIsUploadingPhoto(false)
      setIsDetectingFen(false)
    }
  }

  const loadDetectedFen = () => {
    if (!detectedFenDraft) return

    if (detectionNeedsReview) {
      setShowDetectionEditor(true)
      setDetectedFenEditorDraft(detectedFenDraft)
      setDetectedFenEditorMessage(
        'Confidence is low. Please review this FEN before loading it to avoid studying the wrong position.',
      )
      setPositionMessage('Review the detected FEN before loading it.')
      return
    }

    applyFenPosition(detectedFenDraft, 'Loaded auto-detected FEN from image.')
    setDetectedFenReviewed(true)
  }

  const openDetectionEditor = () => {
    if (!detectedFenDraft) return

    setDetectedFenEditorDraft(detectedFenDraft)
    setShowDetectionEditor(true)
    setDetectedFenEditorMessage(
      detectedStatus === 'low-confidence'
        ? 'Confidence is low. Review this FEN carefully before loading.'
        : null,
    )
  }

  const closeDetectionEditor = () => {
    setShowDetectionEditor(false)
    setDetectedFenEditorMessage(null)
  }

  const applyDetectedFenFromEditor = () => {
    const nextFen = detectedFenEditorDraft.trim()
    const validation = validateFen(nextFen)
    if (!validation.ok) {
      setDetectedFenEditorMessage(validation.error ?? 'Invalid FEN string.')
      return
    }

    setDetectedFenDraft(nextFen)
    setDetectedFenReviewed(true)
    setShowDetectionEditor(false)
    setDetectedFenEditorMessage(null)
    applyFenPosition(nextFen, 'Loaded reviewed FEN from image detection.')
  }

  const removePhotoStudy = (id: string) => {
    const nextPhotos = photoStudies.filter((photo) => photo.id !== id)
    persistPhotoStudies(nextPhotos)
  }

  return (
    <div className="app-shell">
      <header className="hero-panel">
        <div className="hero-grid">
          <div>
            <p className="kicker">Chess Tips Coach</p>
            <h1>Learn Chess With Explanations, Not Guesswork</h1>
            <p className="hero-copy">
              Build intuition from basics to advanced play. Explore candidate moves,
              compare alternatives, and understand why one line is stronger than
              another.
            </p>
            <div className="signal-row">
              <span className="pill">Interactive board</span>
              <span className="pill">Move quality labels</span>
              <span className="pill">{activeEngineLabel}</span>
            </div>

            <nav className="app-nav" aria-label="Primary screens">
              {APP_SCREEN_MENU.map((screen) => (
                <button
                  key={screen.id}
                  type="button"
                  className={`app-nav-button ${activeScreen === screen.id ? 'is-active' : ''}`}
                  onClick={() => navigateToScreen(screen.id)}
                  aria-current={activeScreen === screen.id ? 'page' : undefined}
                >
                  <span>{screen.label}</span>
                  <small>{screen.caption}</small>
                </button>
              ))}
            </nav>
          </div>

          <aside className="hero-facts">
            <h2>Current Position</h2>
            <p>{statusLine}</p>
            <p>{activeSummary}</p>
          </aside>
        </div>
      </header>

      <main className="screen-shell">
        {activeScreen === 'board' ? (
          <section className="board-stage">
            <div className="board-heading">
              <h2>Position Studio</h2>
              <p>Click a piece, then click a target square.</p>
            </div>

            <div className="board-grid" role="grid" aria-label="Chess board">
              {board.map((row, rowIndex) =>
                row.map((squarePiece, fileIndex) => {
                  const square = `${FILES[fileIndex]}${8 - rowIndex}` as Square
                  const isLightSquare = (rowIndex + fileIndex) % 2 === 0
                  const isSelected = selectedSquare === square
                  const isLegalTarget = legalTargets.has(square)
                  const isLastMoveSquare = lastMove?.from === square || lastMove?.to === square
                  const isCheckedKing = checkedKingSquare === square

                  const squareClassName = [
                    'board-square',
                    isLightSquare ? 'square-light' : 'square-dark',
                    isSelected ? 'is-selected' : '',
                    isLegalTarget ? 'is-legal-target' : '',
                    isLastMoveSquare ? 'is-last-move' : '',
                    isCheckedKing ? 'is-checked-king' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')

                  const ariaPiece = squarePiece
                    ? `${colorName(squarePiece.color)} ${PIECE_WORDS[squarePiece.type]}`
                    : 'empty square'

                  return (
                    <button
                      key={square}
                      type="button"
                      className={squareClassName}
                      onClick={() => onSquareClick(square)}
                      aria-label={`${square}, ${ariaPiece}`}
                    >
                      {squarePiece ? (
                        <span className="square-piece">
                          {PIECE_GLYPHS[squarePiece.color][squarePiece.type]}
                        </span>
                      ) : null}
                      {isLegalTarget && !squarePiece ? (
                        <span className="legal-dot" aria-hidden="true"></span>
                      ) : null}
                      <span className="square-id" aria-hidden="true">
                        {square}
                      </span>
                    </button>
                  )
                }),
              )}
            </div>

            <div className="board-controls">
              <button type="button" onClick={undoMove}>Undo</button>
              <button type="button" onClick={resetBoard}>Reset</button>
              <button
                type="button"
                onClick={() => {
                  setSelectedSquare(null)
                  setPositionMessage('Selection cleared.')
                }}
              >
                Clear Selection
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => navigateToScreen('coach')}
              >
                Open Coach Screen
              </button>
            </div>

            <div className="fen-editor">
              <label htmlFor="fen-input">Load Position (FEN)</label>
              <textarea
                id="fen-input"
                value={fenDraft}
                onChange={(event) => setFenDraft(event.target.value)}
                rows={2}
              />
              <button type="button" onClick={loadFen}>Load FEN</button>
            </div>

            {positionMessage ? <p className="position-message">{positionMessage}</p> : null}
          </section>
        ) : null}

        {activeScreen === 'coach' ? (
          <section className="coach-stage">
            <div className="coach-heading">
              <h2>Coach Feedback</h2>
              <p>
                See the top continuations for <strong>{colorName(positionAnalysis.turn)}</strong>.
              </p>
            </div>

            <div className="analysis-controls">
              <label>
                Engine Source
                <select
                  value={engineSource}
                  onChange={(event) => setEngineSource(event.target.value as EngineSource)}
                >
                  <option value="heuristic">Built-in Heuristic</option>
                  <option value="stockfish">Stockfish Worker</option>
                </select>
              </label>

              <label>
                Heuristic Depth
                <select
                  value={analysisDepth}
                  onChange={(event) => setAnalysisDepth(Number(event.target.value))}
                >
                  <option value={1}>1 (fastest)</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4 (stronger)</option>
                </select>
              </label>

              <label>
                Top Lines
                <select
                  value={topLineCount}
                  onChange={(event) => setTopLineCount(Number(event.target.value))}
                >
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                </select>
              </label>

              <label>
                Stockfish Depth
                <select
                  value={stockfishDepth}
                  onChange={(event) => setStockfishDepth(Number(event.target.value))}
                >
                  <option value={8}>8</option>
                  <option value={10}>10</option>
                  <option value={12}>12</option>
                  <option value={14}>14</option>
                  <option value={16}>16</option>
                  <option value={18}>18</option>
                </select>
              </label>
            </div>

            <div className="analysis-action-row">
              <button type="button" onClick={runStockfishAnalysis} disabled={isRunningStockfish}>
                {isRunningStockfish ? 'Running Stockfish...' : 'Run Stockfish'}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => {
                  setStockfishLines([])
                  setStockfishFen(null)
                  setStockfishMessage('Cleared Stockfish lines for this position.')
                }}
              >
                Clear Stockfish Lines
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => navigateToScreen('board')}
              >
                Back To Board
              </button>
            </div>

            <p className="engine-note">
              Active engine: {activeEngineLabel}. Heuristic is instant; Stockfish is stronger but may take longer.
            </p>
            {stockfishMessage ? <p className="engine-note">{stockfishMessage}</p> : null}
            {stockfishError ? <p className="engine-error">{stockfishError}</p> : null}
            {stockfishIsStale ? (
              <p className="engine-note">
                Board changed after the last Stockfish run. Re-run to refresh engine lines.
              </p>
            ) : null}

            <div className="summary-box">
              <p>{activeSummary}</p>
              {bestMove ? (
                <button type="button" onClick={() => playSuggestedMove(bestMove)}>
                  Play Best Move: {bestMove.san}
                </button>
              ) : null}
            </div>

            <ol className="move-list">
              {activeTopMoves.map((move, index) => (
                <li key={move.uci} className="move-card">
                  <div className="move-head">
                    <div>
                      <p className="move-san">#{index + 1} {move.san}</p>
                      <p className="move-eval">Eval {move.scoreLabel}</p>
                    </div>
                    <span className={`quality-chip ${qualityTone(move.quality)}`}>{move.quality}</span>
                  </div>
                  <p className="move-explainer">{move.explanation}</p>
                  {move.warnings.length > 0 ? (
                    <ul className="warning-list">
                      {move.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                  <button type="button" onClick={() => playSuggestedMove(move)}>
                    Play This Move
                  </button>
                </li>
              ))}
            </ol>

            <form className="candidate-form" onSubmit={submitCandidateMove}>
              <label htmlFor="candidate-move">Try your own move</label>
              <input
                id="candidate-move"
                value={candidateDraft}
                onChange={(event) => setCandidateDraft(event.target.value)}
                placeholder="Examples: e4, Nf3, e2e4"
              />
              <button type="submit" disabled={isGradingCandidateWithStockfish}>
                {isGradingCandidateWithStockfish ? 'Grading With Stockfish...' : 'Explain This Move'}
              </button>
            </form>

            {activeCandidateReview ? (
              <div className="candidate-result">
                {activeCandidateReview.candidateError ? (
                  <p>{activeCandidateReview.candidateError}</p>
                ) : null}
                {activeCandidateReview.candidateMove ? (
                  <>
                    <p>
                      <strong>{activeCandidateReview.candidateMove.san}</strong> is rated{' '}
                      <span
                        className={`quality-chip ${qualityTone(activeCandidateReview.candidateMove.quality)}`}
                      >
                        {activeCandidateReview.candidateMove.quality}
                      </span>
                      .
                    </p>
                    <p>{activeCandidateReview.candidateMove.explanation}</p>
                    {activeCandidateReview.candidateComparison ? (
                      <p>{activeCandidateReview.candidateComparison}</p>
                    ) : null}
                    {activeCandidateReview.source === 'stockfish' ? (
                      <p>Candidate grading source: Stockfish.</p>
                    ) : (
                      <p>Candidate grading source: Built-in heuristic engine.</p>
                    )}
                  </>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : null}

        {activeScreen === 'study' ? (
          <section className="path-section">
            <div className="section-heading">
              <h2>Progress And Photo Study</h2>
              <p>
                Track your move quality over time and attach board photos to the exact position.
              </p>
            </div>

            <div className="utility-grid">
              <article className="utility-card">
                <div className="utility-head">
                  <h3>Progress Tracker</h3>
                  <button type="button" className="ghost-button" onClick={clearStudyHistory}>
                    Clear
                  </button>
                </div>

                <div className="profile-controls">
                  <label>
                    Active Profile
                    <select
                      value={activeProfile.id}
                      onChange={(event) => switchActiveProfile(event.target.value)}
                    >
                      {profiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="profile-create-row">
                    <input
                      value={newProfileName}
                      onChange={(event) => setNewProfileName(event.target.value)}
                      placeholder="Create profile (e.g., Opening Prep)"
                    />
                    <button type="button" onClick={createProfile}>Add</button>
                  </div>

                  <div className="history-actions">
                    <button type="button" onClick={pushCloudSync} disabled={isSyncing}>
                      {isSyncing ? 'Syncing...' : 'Push To Cloud'}
                    </button>
                    <button type="button" className="ghost-button" onClick={pullCloudSync} disabled={isSyncing}>
                      Pull From Cloud
                    </button>
                  </div>

                  {syncMessage ? <p className="history-note">{syncMessage}</p> : null}
                  {activeProfile.lastSyncedAt ? (
                    <p className="history-meta">Last synced {formatDateTime(activeProfile.lastSyncedAt)}</p>
                  ) : null}
                </div>

                {studyHistory.length === 0 ? (
                  <p className="empty-note">
                    Submit candidate moves to start building your personal learning history.
                  </p>
                ) : (
                  <>
                    <div className="stats-row">
                      <span className="stat-chip">Reviews {historySummary.total}</span>
                      <span className="stat-chip">Best/Strong {historySummary.bestStrong}</span>
                      <span className="stat-chip">Playable {historySummary.playable}</span>
                      <span className="stat-chip">Mistakes {historySummary.mistakes}</span>
                    </div>

                    {historySummary.topWarning ? (
                      <p className="warning-signal">Common risk: {historySummary.topWarning}</p>
                    ) : null}

                    <ol className="history-list">
                      {studyHistory.slice(0, 6).map((item) => (
                        <li key={item.id} className="history-item">
                          <p className="history-line">
                            <strong>{item.moveSan}</strong> rated{' '}
                            <span className={`quality-chip ${qualityTone(item.quality)}`}>
                              {item.quality}
                            </span>{' '}
                            for {colorName(item.sideToMove)}.
                          </p>
                          <p className="history-meta">
                            {formatDateTime(item.timestamp)} · input {item.moveInput} · eval {item.scoreLabel}
                          </p>
                          {item.comparison ? <p className="history-note">{item.comparison}</p> : null}
                          <div className="history-actions">
                            <button
                              type="button"
                              onClick={() => {
                                applyFenPosition(item.fen, 'Loaded position from your progress tracker.')
                                navigateToScreen('board')
                              }}
                            >
                              Load Position
                            </button>
                            <button type="button" className="ghost-button" onClick={() => removeHistoryItem(item.id)}>
                              Delete
                            </button>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </article>

              <article className="utility-card">
                <div className="utility-head">
                  <h3>Photo Study Upload</h3>
                </div>
                <p className="history-note">
                  Upload a board screenshot to link and auto-detect FEN. Best results: straight 2D board images.
                </p>
                <label>
                  Side To Move For Detection
                  <select
                    value={detectTurn}
                    onChange={(event) => setDetectTurn(event.target.value as Side)}
                  >
                    <option value="w">White to move</option>
                    <option value="b">Black to move</option>
                  </select>
                </label>

                <label className="upload-field" htmlFor="photo-upload">Select Image</label>
                <input
                  id="photo-upload"
                  type="file"
                  accept="image/*"
                  onChange={uploadPhotoStudy}
                  className="upload-input"
                />

                {isUploadingPhoto ? <p className="history-meta">Processing image...</p> : null}
                {isDetectingFen ? <p className="history-meta">Detecting board and generating FEN...</p> : null}
                {imageMessage ? <p className="position-message">{imageMessage}</p> : null}

                {detectedFenDraft ? (
                  <div className="detected-fen-box">
                    <p className="history-note">Detected orientation: {detectedOrientation ?? 'unknown'}</p>
                    <p className="history-note">Detection status: {detectedStatus ?? 'unknown'}</p>
                    {detectionNeedsReview ? (
                      <p className="engine-error">
                        Low confidence detected. Review and edit this FEN before loading.
                      </p>
                    ) : null}
                    <p className="history-meta">{detectedFenDraft}</p>
                    <div className="history-actions">
                      <button
                        type="button"
                        onClick={detectionNeedsReview ? openDetectionEditor : loadDetectedFen}
                      >
                        {detectionNeedsReview ? 'Review Before Load' : 'Load Detected FEN'}
                      </button>
                      <button type="button" className="ghost-button" onClick={openDetectionEditor}>
                        Open FEN Editor
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={() => {
                          setFenDraft(detectedFenDraft)
                          setPositionMessage('Detected FEN copied into editor. Review and load when ready.')
                          navigateToScreen('board')
                        }}
                      >
                        Copy To FEN Editor
                      </button>
                    </div>
                  </div>
                ) : null}

                {photoStudies.length === 0 ? (
                  <p className="empty-note">No photo studies yet.</p>
                ) : (
                  <ul className="photo-list">
                    {photoStudies.map((photo) => (
                      <li key={photo.id} className="photo-item">
                        <img src={photo.previewDataUrl} alt={`Uploaded board ${photo.fileName}`} />
                        <div>
                          <p className="history-line"><strong>{photo.fileName}</strong></p>
                          <p className="history-meta">{formatDateTime(photo.createdAt)}</p>
                          <div className="history-actions">
                            <button
                              type="button"
                              onClick={() => {
                                applyFenPosition(photo.linkedFen, 'Loaded position linked to this photo.')
                                navigateToScreen('board')
                              }}
                            >
                              Load Linked Position
                            </button>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => removePhotoStudy(photo.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            </div>
          </section>
        ) : null}

        {activeScreen === 'learn' ? (
          <>
            <section className="path-section">
              <div className="section-heading">
                <h2>Learning Paths</h2>
                <p>From fundamentals to high-level decision making.</p>
              </div>
              <div className="card-grid">
                {LEARNING_TRACKS.map((track) => (
                  <article key={track.level} className="path-card">
                    <p className="card-kicker">{track.level}</p>
                    <h3>{track.target}</h3>
                    <ul>
                      {track.outcomes.map((outcome) => (
                        <li key={outcome}>{outcome}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            </section>

            <section className="path-section">
              <div className="section-heading">
                <h2>Multi-Format Expansion</h2>
                <p>Ready for image upload, video analysis, and live guidance workflows.</p>
              </div>
              <div className="card-grid">
                {EXPANSION_MODES.map((mode) => (
                  <article key={mode.title} className="mode-card">
                    <h3>{mode.title}</h3>
                    <p>{mode.text}</p>
                  </article>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </main>

      {showDetectionEditor ? (
        <div className="dialog-backdrop" onClick={closeDetectionEditor}>
          <div
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detected-fen-editor-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="detected-fen-editor-title">Review Detected Position</h3>
            <p className="history-note">Edit this FEN if needed, then load it onto the board.</p>
            <label htmlFor="detected-fen-editor">Detected FEN</label>
            <textarea
              id="detected-fen-editor"
              value={detectedFenEditorDraft}
              rows={3}
              onChange={(event) => {
                setDetectedFenEditorDraft(event.target.value)
                if (detectedFenEditorMessage) setDetectedFenEditorMessage(null)
              }}
            />
            {detectedFenEditorMessage ? (
              <p className="position-message">{detectedFenEditorMessage}</p>
            ) : null}
            <div className="history-actions">
              <button type="button" onClick={applyDetectedFenFromEditor}>Load Reviewed FEN</button>
              <button type="button" className="ghost-button" onClick={closeDetectionEditor}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
