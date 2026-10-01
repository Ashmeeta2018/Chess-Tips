const STOCKFISH_SCRIPT_URL =
  'https://unpkg.com/stockfish.js@10.0.2/stockfish.wasm.js'
const STOCKFISH_WASM_URL =
  'https://unpkg.com/stockfish.js@10.0.2/stockfish.wasm'

const DEFAULT_DEPTH = 12
const DEFAULT_MULTI_PV = 3
const DEFAULT_TIMEOUT_MS = 12_000

export interface StockfishLine {
  multipv: number
  depth: number
  scoreType: 'cp' | 'mate'
  score: number
  uci: string
  pv: string[]
}

export interface StockfishReport {
  lines: StockfishLine[]
  bestMove: string | null
  depth: number
  source: string
}

export interface StockfishOptions {
  depth?: number
  multiPv?: number
  timeoutMs?: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const parseInfoLine = (line: string): StockfishLine | null => {
  if (!line.startsWith('info ')) {
    return null
  }

  const tokens = line.trim().split(/\s+/)
  const depthIndex = tokens.indexOf('depth')
  const multiPvIndex = tokens.indexOf('multipv')
  const scoreIndex = tokens.indexOf('score')
  const pvIndex = tokens.indexOf('pv')

  if (depthIndex < 0 || scoreIndex < 0 || pvIndex < 0) {
    return null
  }

  const depth = Number(tokens[depthIndex + 1])
  const multipv = multiPvIndex > -1 ? Number(tokens[multiPvIndex + 1]) : 1
  const scoreType = tokens[scoreIndex + 1]
  const score = Number(tokens[scoreIndex + 2])
  const pv = tokens.slice(pvIndex + 1)

  if (!Number.isFinite(depth) || !Number.isFinite(multipv) || !pv[0]) {
    return null
  }

  if (scoreType !== 'cp' && scoreType !== 'mate') {
    return null
  }

  if (!Number.isFinite(score)) {
    return null
  }

  return {
    multipv,
    depth,
    scoreType,
    score,
    uci: pv[0],
    pv,
  }
}

export const scoreFromLine = (line: StockfishLine): number =>
  line.scoreType === 'mate'
    ? line.score > 0
      ? 100_000 - Math.abs(line.score) * 100
      : -100_000 + Math.abs(line.score) * 100
    : line.score

export const formatStockfishScore = (line: StockfishLine): string => {
  if (line.scoreType === 'mate') {
    const sign = line.score > 0 ? '+' : '-'
    return `M${sign}${Math.abs(line.score)}`
  }

  const pawnScore = line.score / 100
  return `${pawnScore >= 0 ? '+' : ''}${pawnScore.toFixed(2)}`
}

const parseBestMove = (line: string): string | null => {
  if (!line.startsWith('bestmove ')) {
    return null
  }

  const tokens = line.split(/\s+/)
  if (tokens.length < 2 || tokens[1] === '(none)') {
    return null
  }

  return tokens[1]
}

const createStockfishWorker = (): {
  worker: Worker
  revokeBlobUrl: () => void
} => {
  const bootstrap = `
    fetch('${STOCKFISH_SCRIPT_URL}')
      .then(function(response) {
        return response.text();
      })
      .then(function(source) {
        var patched = source.replace(/stockfish\\.wasm/g, '${STOCKFISH_WASM_URL}');
        (0, eval)(patched);
        self.postMessage('__STOCKFISH_LOADED__');
      })
      .catch(function(error) {
        self.postMessage('__STOCKFISH_LOAD_ERROR__:' + (error && error.message ? error.message : String(error)));
      });
  `

  const blobUrl = URL.createObjectURL(
    new Blob([bootstrap], { type: 'application/javascript' }),
  )

  return {
    worker: new Worker(blobUrl),
    revokeBlobUrl: () => URL.revokeObjectURL(blobUrl),
  }
}

export const analyzeWithStockfish = async (
  fen: string,
  options?: StockfishOptions,
): Promise<StockfishReport> => {
  const depth = clamp(Math.round(options?.depth ?? DEFAULT_DEPTH), 6, 20)
  const multiPv = clamp(Math.round(options?.multiPv ?? DEFAULT_MULTI_PV), 1, 5)
  const timeoutMs = clamp(
    Math.round(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    4_000,
    30_000,
  )

  return new Promise<StockfishReport>((resolve, reject) => {
    let worker: Worker
    let revokeBlobUrl = () => {}
    try {
      const created = createStockfishWorker()
      worker = created.worker
      revokeBlobUrl = created.revokeBlobUrl
    } catch (error) {
      reject(
        new Error(
          `Could not start Stockfish worker. ${(error as Error).message}`,
        ),
      )
      return
    }

    const linesByMultiPv = new Map<number, StockfishLine>()
    let startedSearch = false
    let settled = false
    let bestMove: string | null = null

    let timeoutId: number | null = null
    let stopTimeoutId: number | null = null

    const cleanup = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId)
      }
      if (stopTimeoutId !== null) {
        window.clearTimeout(stopTimeoutId)
      }
      worker.terminate()
      revokeBlobUrl()
    }

    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      const lines = [...linesByMultiPv.values()]
        .sort((a, b) => a.multipv - b.multipv)
        .slice(0, multiPv)

      resolve({
        lines,
        bestMove,
        depth,
        source: 'stockfish.js 10.0.2 WASM worker',
      })
    }

    timeoutId = window.setTimeout(() => {
      if (settled) {
        return
      }
      worker.postMessage('stop')
      stopTimeoutId = window.setTimeout(() => {
        finish()
      }, 350)
    }, timeoutMs)

    worker.onerror = (error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(new Error(`Stockfish worker error: ${error.message}`))
    }

    worker.onmessage = (event: MessageEvent) => {
      const raw = event.data
      const line = typeof raw === 'string' ? raw.trim() : ''

      if (!line) {
        return
      }

      if (line.startsWith('__STOCKFISH_LOAD_ERROR__:')) {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(new Error(line.replace('__STOCKFISH_LOAD_ERROR__:', '')))
        return
      }

      if (line === '__STOCKFISH_LOADED__') {
        worker.postMessage('uci')
        return
      }

      if (line === 'uciok') {
        worker.postMessage(`setoption name MultiPV value ${multiPv}`)
        worker.postMessage('isready')
        return
      }

      if (line === 'readyok' && !startedSearch) {
        startedSearch = true
        worker.postMessage('ucinewgame')
        worker.postMessage(`position fen ${fen}`)
        worker.postMessage(`go depth ${depth}`)
        return
      }

      if (line.startsWith('info ')) {
        const parsed = parseInfoLine(line)
        if (parsed) {
          const existing = linesByMultiPv.get(parsed.multipv)
          if (!existing || parsed.depth >= existing.depth) {
            linesByMultiPv.set(parsed.multipv, parsed)
          }
        }
        return
      }

      if (line.startsWith('bestmove ')) {
        bestMove = parseBestMove(line)
        finish()
      }
    }

  })
}
