import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js'

const MATE_SCORE = 100_000
const SEARCH_DEPTH = 2

const pieceValues: Record<PieceSymbol, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
}

const pieceNames: Record<PieceSymbol, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
}

const centerSquares: Square[] = ['d4', 'e4', 'd5', 'e5']

export interface MoveAdvice {
  san: string
  uci: string
  score: number
  scoreLabel: string
  loss: number
  quality: string
  explanation: string
  warnings: string[]
  bestReply: string | null
}

export interface PositionAnalysis {
  fen: string
  turn: Color
  summary: string
  depth: number
  engineLabel: string
  bestMove: MoveAdvice | null
  topMoves: MoveAdvice[]
  candidateMove: MoveAdvice | null
  candidateComparison: string | null
  candidateError: string | null
}

export interface AnalysisOptions {
  depth?: number
  topMovesCount?: number
}

interface RankedMove extends MoveAdvice {
  move: Move
  highlights: string[]
}

const oppositeColor = (color: Color): Color => (color === 'w' ? 'b' : 'w')

export const colorName = (color: Color): string =>
  color === 'w' ? 'White' : 'Black'

const toUci = (move: Move): string =>
  `${move.from}${move.to}${move.promotion ?? ''}`

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const squareCoordinates = (square: Square): { file: number; rank: number } => {
  const file = square.charCodeAt(0) - 97
  const rank = Number(square.slice(1))
  return { file, rank }
}

const positionalBonus = (
  piece: PieceSymbol,
  color: Color,
  square: Square,
): number => {
  const { file, rank } = squareCoordinates(square)
  const centerFileDistance = Math.abs(file - 3.5)
  const centerRankDistance = Math.abs(rank - 4.5)
  const centrality = 3.5 - (centerFileDistance + centerRankDistance) / 2

  if (piece === 'p') {
    const advancement = color === 'w' ? rank - 2 : 7 - rank
    const centerTouch = file >= 2 && file <= 5 ? 6 : 0
    return advancement * 6 + centerTouch
  }

  if (piece === 'n') {
    return Math.round(centrality * 18)
  }

  if (piece === 'b') {
    return Math.round(centrality * 14)
  }

  if (piece === 'r') {
    const openFileBonus = file === 0 || file === 7 ? -2 : 6
    return openFileBonus + Math.round(centrality * 4)
  }

  if (piece === 'q') {
    return Math.round(centrality * 8)
  }

  if (piece === 'k') {
    const castledBonus =
      square === 'g1' || square === 'c1' || square === 'g8' || square === 'c8'
        ? 18
        : 0
    const edgePenalty = clamp(Math.round(centrality * 12), -24, 24)
    return castledBonus - edgePenalty
  }

  return 0
}

const evaluateForWhite = (chess: Chess): number => {
  if (chess.isCheckmate()) {
    return chess.turn() === 'w' ? -MATE_SCORE : MATE_SCORE
  }

  if (chess.isDraw()) {
    return 0
  }

  let score = 0

  for (const row of chess.board()) {
    for (const squarePiece of row) {
      if (!squarePiece) {
        continue
      }

      const baseValue = pieceValues[squarePiece.type]
      const bonus = positionalBonus(
        squarePiece.type,
        squarePiece.color,
        squarePiece.square,
      )
      const signedValue = baseValue + bonus
      score += squarePiece.color === 'w' ? signedValue : -signedValue
    }
  }

  for (const square of centerSquares) {
    if (chess.isAttacked(square, 'w')) {
      score += 10
    }
    if (chess.isAttacked(square, 'b')) {
      score -= 10
    }
  }

  const tempo = chess.moves().length * 2
  score += chess.turn() === 'w' ? tempo : -tempo

  if (chess.isCheck()) {
    score += chess.turn() === 'w' ? -30 : 30
  }

  return Math.round(score)
}

const evaluateForPerspective = (chess: Chess, perspective: Color): number => {
  const whiteScore = evaluateForWhite(chess)
  return perspective === 'w' ? whiteScore : -whiteScore
}

const minimax = (
  chess: Chess,
  depth: number,
  alpha: number,
  beta: number,
  maximizingColor: Color,
): number => {
  if (depth === 0 || chess.isGameOver()) {
    return evaluateForPerspective(chess, maximizingColor)
  }

  const legalMoves = chess.moves({ verbose: true })
  const maximizingNode = chess.turn() === maximizingColor

  if (maximizingNode) {
    let best = -MATE_SCORE

    for (const move of legalMoves) {
      chess.move(move)
      const score = minimax(chess, depth - 1, alpha, beta, maximizingColor)
      chess.undo()
      best = Math.max(best, score)
      alpha = Math.max(alpha, best)
      if (beta <= alpha) {
        break
      }
    }

    return best
  }

  let best = MATE_SCORE

  for (const move of legalMoves) {
    chess.move(move)
    const score = minimax(chess, depth - 1, alpha, beta, maximizingColor)
    chess.undo()
    best = Math.min(best, score)
    beta = Math.min(beta, best)
    if (beta <= alpha) {
      break
    }
  }

  return best
}

const getBestReply = (
  chess: Chess,
  perspective: Color,
): { san: string; score: number } | null => {
  const legalMoves = chess.moves({ verbose: true })
  if (legalMoves.length === 0) {
    return null
  }

  let bestSan = legalMoves[0].san
  let bestScore = MATE_SCORE

  for (const move of legalMoves) {
    chess.move(move)
    const score = evaluateForPerspective(chess, perspective)
    chess.undo()

    if (score < bestScore) {
      bestScore = score
      bestSan = move.san
    }
  }

  return { san: bestSan, score: bestScore }
}

const qualityFromLoss = (loss: number): string => {
  if (loss <= 20) {
    return 'Best'
  }
  if (loss <= 80) {
    return 'Strong'
  }
  if (loss <= 180) {
    return 'Playable'
  }
  if (loss <= 320) {
    return 'Inaccuracy'
  }
  if (loss <= 500) {
    return 'Mistake'
  }
  return 'Blunder'
}

const buildWarnings = (
  chessAfterMove: Chess,
  move: Move,
  sideToMove: Color,
): string[] => {
  const warnings: string[] = []
  const opponent = oppositeColor(sideToMove)

  const destinationAttacked = chessAfterMove.isAttacked(move.to, opponent)
  const destinationDefended = chessAfterMove.isAttacked(move.to, sideToMove)
  if (destinationAttacked && !destinationDefended) {
    warnings.push(
      `The moved ${pieceNames[move.piece]} on ${move.to} can be attacked without direct support.`,
    )
  }

  const totalPlies = chessAfterMove.history().length
  if (move.piece === 'q' && totalPlies < 10) {
    warnings.push(
      'Early queen moves can invite tempo-gaining attacks from minor pieces.',
    )
  }

  return warnings
}

const buildHighlights = (chessAfterMove: Chess, move: Move): string[] => {
  const highlights: string[] = []

  if (move.isCapture() && move.captured) {
    highlights.push(`captures a ${pieceNames[move.captured]}`)
  }

  if (move.isPromotion()) {
    highlights.push(`promotes to a ${pieceNames[move.promotion ?? 'q']}`)
  }

  if (move.isKingsideCastle()) {
    highlights.push('castles king-side to improve king safety')
  }

  if (move.isQueensideCastle()) {
    highlights.push('castles queen-side to connect rooks quickly')
  }

  if (chessAfterMove.isCheck()) {
    highlights.push('gives check and forces a response')
  }

  if (centerSquares.includes(move.to)) {
    highlights.push('strengthens central control')
  }

  if (move.piece === 'n' || move.piece === 'b') {
    const homeRank = move.color === 'w' ? '1' : '8'
    if (move.from.endsWith(homeRank)) {
      highlights.push('develops a minor piece from the back rank')
    }
  }

  if (highlights.length === 0) {
    highlights.push('improves piece coordination')
  }

  return highlights
}

const scoreLabel = (score: number): string => {
  const pawnScore = score / 100
  return `${pawnScore >= 0 ? '+' : ''}${pawnScore.toFixed(2)}`
}

const buildExplanation = (
  highlights: string[],
  warnings: string[],
  loss: number,
  bestReply: string | null,
): string => {
  const opening = `This move ${highlights.join(', ')}.`

  if (loss <= 80) {
    return `${opening} It keeps your position in the top tier of choices.`
  }

  if (loss <= 320) {
    return `${opening} It is playable, but less accurate than the strongest line.`
  }

  const replyText = bestReply
    ? ` A strong answer is ${bestReply}, which can shift momentum to your opponent.`
    : ''

  const riskText =
    warnings.length > 0
      ? ` Main risk: ${warnings[0]}`
      : ' This move gives away too much evaluation compared with the best option.'

  return `${opening}${replyText}${riskText}`
}

const stripMove = (rankedMove: RankedMove): MoveAdvice => ({
  san: rankedMove.san,
  uci: rankedMove.uci,
  score: rankedMove.score,
  scoreLabel: rankedMove.scoreLabel,
  loss: rankedMove.loss,
  quality: rankedMove.quality,
  explanation: rankedMove.explanation,
  warnings: rankedMove.warnings,
  bestReply: rankedMove.bestReply,
})

const rankMoves = (chess: Chess, depth = SEARCH_DEPTH): RankedMove[] => {
  const sideToMove = chess.turn()
  const legalMoves = chess.moves({ verbose: true })
  const ranked: RankedMove[] = []

  for (const move of legalMoves) {
    chess.move(move)

    const score = minimax(
      chess,
      Math.max(depth - 1, 0),
      -MATE_SCORE,
      MATE_SCORE,
      sideToMove,
    )

    const bestReply = getBestReply(chess, sideToMove)
    const warnings = buildWarnings(chess, move, sideToMove)
    const highlights = buildHighlights(chess, move)

    chess.undo()

    ranked.push({
      move,
      san: move.san,
      uci: toUci(move),
      score,
      scoreLabel: scoreLabel(score),
      loss: 0,
      quality: 'Best',
      explanation: '',
      warnings,
      bestReply: bestReply?.san ?? null,
      highlights,
    })
  }

  ranked.sort((left, right) => right.score - left.score)
  const bestScore = ranked[0]?.score ?? 0

  for (const move of ranked) {
    const loss = Math.max(0, bestScore - move.score)
    move.loss = loss
    move.quality = qualityFromLoss(loss)
    move.explanation = buildExplanation(
      move.highlights,
      move.warnings,
      loss,
      move.bestReply,
    )
  }

  return ranked
}

const parseCandidateMove = (
  fen: string,
  candidateInput: string,
): { uci: string; san: string } | { error: string } => {
  const trimmedMove = candidateInput.trim()
  if (!trimmedMove) {
    return {
      error: 'Enter a move like e4, Nf3, or e2e4.',
    }
  }

  const checker = new Chess(fen)

  try {
    const uciMatch = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/i.exec(trimmedMove)
    let move: Move

    if (uciMatch) {
      const [, from, to, promotion] = uciMatch
      move = checker.move(
        {
          from: from.toLowerCase(),
          to: to.toLowerCase(),
          promotion: promotion?.toLowerCase(),
        },
        { strict: false },
      )
    } else {
      move = checker.move(trimmedMove, { strict: false })
    }

    return {
      uci: toUci(move),
      san: move.san,
    }
  } catch {
    return {
      error: 'That move is not legal in this exact position.',
    }
  }
}

export const analyzePosition = (
  fen: string,
  candidateInput?: string,
  options?: AnalysisOptions,
): PositionAnalysis => {
  const chess = new Chess(fen)
  const depth = clamp(Math.round(options?.depth ?? SEARCH_DEPTH), 1, 4)
  const topMovesCount = clamp(Math.round(options?.topMovesCount ?? 3), 1, 6)
  const rankedMoves = rankMoves(chess, depth)

  const bestMove = rankedMoves.length > 0 ? stripMove(rankedMoves[0]) : null
  const topMoves = rankedMoves.slice(0, topMovesCount).map(stripMove)

  let summary = `It is ${colorName(chess.turn())} to move.`
  if (bestMove) {
    summary += ` Best continuation: ${bestMove.san} (${bestMove.scoreLabel}).`
  } else if (chess.isCheckmate()) {
    summary += ` Game over by checkmate: ${colorName(chess.turn() === 'w' ? 'b' : 'w')} has won.`
  } else if (chess.isDraw()) {
    summary += ' The position is drawn.'
  }
  summary += ` Engine depth: ${depth}.`

  let candidateMove: MoveAdvice | null = null
  let candidateComparison: string | null = null
  let candidateError: string | null = null

  if (candidateInput && candidateInput.trim()) {
    const parsedCandidate = parseCandidateMove(fen, candidateInput)

    if ('error' in parsedCandidate) {
      candidateError = parsedCandidate.error
    } else {
      const foundMove = rankedMoves.find((move) => move.uci === parsedCandidate.uci)
      if (foundMove) {
        candidateMove = stripMove(foundMove)

        if (!bestMove || candidateMove.loss <= 20) {
          candidateComparison =
            'This move is effectively tied with the best option in this position.'
        } else {
          candidateComparison = `Compared with ${bestMove.san}, this move drops about ${(candidateMove.loss / 100).toFixed(2)} pawns in this model.`
        }
      } else {
        candidateError =
          'Move recognized but could not be matched to current legal move list.'
      }
    }
  }

  return {
    fen,
    turn: chess.turn(),
    summary,
    depth,
    engineLabel: `Heuristic minimax depth ${depth}`,
    bestMove,
    topMoves,
    candidateMove,
    candidateComparison,
    candidateError,
  }
}
