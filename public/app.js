/* global Chess, Chessboard, $ */

// ── State ──
let gameMoves = [];    // { san, moveNumber, mover, ply } from local PGN parse
let analysisData = []; // full analysis entries from server
let board = null;
let currentPly = 0;
let moveFilter = 'all';
let isAnalyzing = false;
let boardFlipped = false;

// ── DOM refs ──
const analyzeBtn = document.getElementById('analyzeBtn');
const sampleBtn = document.getElementById('sampleBtn');
const pgnInput = document.getElementById('pgn');
const gameUrlInput = document.getElementById('gameUrl');
const statusEl = document.getElementById('status');
const inputPanel = document.getElementById('inputPanel');
const analysisSection = document.getElementById('analysisSection');
const summaryPanel = document.getElementById('summaryPanel');
const moveListEl = document.getElementById('moveList');
const coachPanel = document.getElementById('coachPanel');
const evalFill = document.getElementById('evalFill');
const evalLabel = document.getElementById('evalLabel');
const progressBar = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const progressSection = document.getElementById('progressSection');
const newAnalysisBtn = document.getElementById('newAnalysisBtn');

const samplePgn = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.01.01"]
[White "WhitePlayer"]
[Black "BlackPlayer"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 1-0`;

// ── Init board ──
function initBoard() {
  if (board) board.destroy();
  board = Chessboard('board', {
    position: 'start',
    pieceTheme: '/img/pieces/{piece}.png',
    appearSpeed: 150,
    moveSpeed: 150
  });
  initArrowOverlay();
}

// ── Arrow overlay ──
let arrowSvg = null;

function initArrowOverlay() {
  const old = document.getElementById('arrowOverlay');
  if (old) old.remove();

  const boardEl = document.getElementById('board');
  if (!boardEl) return;

  boardEl.style.position = 'relative';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'arrowOverlay';
  svg.setAttribute('class', 'arrow-overlay');
  boardEl.appendChild(svg);
  arrowSvg = svg;
}

function squareToPixel(sq, boardSize) {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const sqSize = boardSize / 8;
  if (boardFlipped) {
    return {
      x: (7 - file) * sqSize + sqSize / 2,
      y: rank * sqSize + sqSize / 2
    };
  }
  return {
    x: file * sqSize + sqSize / 2,
    y: (7 - rank) * sqSize + sqSize / 2
  };
}

function drawArrow(fromSq, toSq, color, opacity, boardSize, tooltipConfig) {
  if (!arrowSvg || !fromSq || !toSq || fromSq === toSq) return;

  const from = squareToPixel(fromSq, boardSize);
  const to = squareToPixel(toSq, boardSize);
  const sqSize = boardSize / 8;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;

  // Proportions relative to square size
  const shaftW = sqSize * 0.22;
  const headW = sqSize * 0.52;
  const headL = sqSize * 0.42;

  // Start slightly out from center of source square
  const startOff = sqSize * 0.15;
  const sx = from.x + ux * startOff;
  const sy = from.y + uy * startOff;

  // Tip stops short of center of target square
  const tipOff = sqSize * 0.1;
  const tipX = to.x - ux * tipOff;
  const tipY = to.y - uy * tipOff;

  // Arrowhead base
  const bx = tipX - ux * headL;
  const by = tipY - uy * headL;

  const pts = [
    `${sx + px * shaftW / 2},${sy + py * shaftW / 2}`,
    `${bx + px * shaftW / 2},${by + py * shaftW / 2}`,
    `${bx + px * headW / 2},${by + py * headW / 2}`,
    `${tipX},${tipY}`,
    `${bx - px * headW / 2},${by - py * headW / 2}`,
    `${bx - px * shaftW / 2},${by - py * shaftW / 2}`,
    `${sx - px * shaftW / 2},${sy - py * shaftW / 2}`
  ];

  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', pts.join(' '));
  polygon.setAttribute('fill', color);
  polygon.setAttribute('fill-opacity', opacity);

  // Make arrow interactive if it has tooltip text
  if (tooltipConfig && tooltipConfig.text) {
    polygon.style.pointerEvents = 'auto';
    polygon.style.cursor = 'pointer';
    const midX = (from.x + to.x) / 2;
    const midY = Math.min(from.y, to.y);
    const ttType = tooltipConfig.type || 'played';
    const ttText = tooltipConfig.text;

    polygon.addEventListener('mouseenter', () => {
      userInteractedWithTooltip = true;
      polygon.setAttribute('fill-opacity', Math.min(1, opacity + 0.2));
      showArrowTooltip(ttText, midX, midY, ttType);
      activeTooltipArrow = polygon;
    });
    polygon.addEventListener('mouseleave', () => {
      polygon.setAttribute('fill-opacity', opacity);
      // Only hide if this arrow's tooltip is showing
      if (activeTooltipArrow === polygon) hideArrowTooltip();
    });
    polygon.addEventListener('click', (e) => {
      e.stopPropagation();
      userInteractedWithTooltip = true;
      if (activeTooltipArrow === polygon && arrowTooltipEl && arrowTooltipEl.style.display !== 'none') {
        hideArrowTooltip();
      } else {
        showArrowTooltip(ttText, midX, midY, ttType);
        activeTooltipArrow = polygon;
      }
    });
  }

  arrowSvg.appendChild(polygon);
  return polygon;
}

function highlightSquare(sq, color, opacity, boardSize) {
  if (!arrowSvg || !sq) return;
  const sqSize = boardSize / 8;
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const x = boardFlipped ? (7 - file) * sqSize : file * sqSize;
  const y = boardFlipped ? rank * sqSize : (7 - rank) * sqSize;

  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', x);
  rect.setAttribute('y', y);
  rect.setAttribute('width', sqSize);
  rect.setAttribute('height', sqSize);
  rect.setAttribute('fill', color);
  rect.setAttribute('fill-opacity', opacity);
  arrowSvg.appendChild(rect);
}

function clearArrows() {
  if (!arrowSvg) return;
  while (arrowSvg.firstChild) arrowSvg.removeChild(arrowSvg.firstChild);
  cancelAutoTooltips();
  hideArrowTooltip();
}

// ── Arrow tooltips ──
let arrowTooltipEl = null;
let activeTooltipArrow = null; // track which arrow's tooltip is showing
let autoTooltipTimers = [];    // timers for auto-show sequence
let userInteractedWithTooltip = false; // skip auto-fade if user hovered

function ensureArrowTooltip() {
  if (arrowTooltipEl) return arrowTooltipEl;
  const el = document.createElement('div');
  el.id = 'arrowTooltip';
  el.className = 'arrow-tooltip';
  el.style.display = 'none';
  const boardEl = document.getElementById('board');
  if (boardEl) boardEl.appendChild(el);
  arrowTooltipEl = el;

  // Click outside board hides tooltip
  document.addEventListener('click', (e) => {
    if (arrowTooltipEl && arrowTooltipEl.style.display !== 'none') {
      const boardEl = document.getElementById('board');
      if (boardEl && !boardEl.contains(e.target)) hideArrowTooltip();
    }
  });

  return el;
}

function showArrowTooltip(text, x, y, type) {
  const tip = ensureArrowTooltip();
  const boardEl = document.getElementById('board');
  if (!boardEl || !text) return;

  tip.textContent = text;
  tip.className = 'arrow-tooltip arrow-tooltip-' + type;
  tip.style.display = 'block';

  const boardW = boardEl.offsetWidth;
  const boardH = boardEl.offsetHeight;

  // Position relative to board container
  // First render to measure
  tip.style.left = '0px';
  tip.style.top = '0px';
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;

  // Place tooltip near the arrow endpoint, clamped inside board
  let left = x - tipW / 2;
  let top = y - tipH - 10;

  // If it goes above the board, flip below
  if (top < 4) top = y + 14;
  // Clamp horizontally
  left = Math.max(4, Math.min(left, boardW - tipW - 4));
  // Clamp vertically
  top = Math.max(4, Math.min(top, boardH - tipH - 4));

  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}

function hideArrowTooltip() {
  if (arrowTooltipEl) {
    arrowTooltipEl.style.display = 'none';
    arrowTooltipEl.classList.remove('arrow-tooltip-fading');
  }
  activeTooltipArrow = null;
}

function cancelAutoTooltips() {
  for (const t of autoTooltipTimers) {
    clearTimeout(t);
    clearInterval(t); // also handles setInterval IDs
  }
  autoTooltipTimers = [];
  userInteractedWithTooltip = false;
}

function fadeOutArrowTooltip(afterMs) {
  return setTimeout(() => {
    if (userInteractedWithTooltip) return; // user took over, don't auto-fade
    if (arrowTooltipEl && arrowTooltipEl.style.display !== 'none') {
      arrowTooltipEl.classList.add('arrow-tooltip-fading');
      const fadeTimer = setTimeout(() => {
        if (arrowTooltipEl) {
          arrowTooltipEl.style.display = 'none';
          arrowTooltipEl.classList.remove('arrow-tooltip-fading');
        }
        activeTooltipArrow = null;
      }, 500); // match CSS transition duration
      autoTooltipTimers.push(fadeTimer);
    }
  }, afterMs);
}

function drawArrowsForPly() {
  clearArrows();
  cancelAutoTooltips();
  if (currentPly === 0) return;

  const move = analysisData[currentPly - 1];
  if (!move || !move.uci || move.uci.length < 4) return;

  const boardEl = document.getElementById('board');
  if (!boardEl) return;
  const boardSize = boardEl.offsetWidth;

  const playedFrom = move.uci.slice(0, 2);
  const playedTo = move.uci.slice(2, 4);
  const label = move.label || 'ok';
  const isBad = label === 'blunder' || label === 'mistake' || label === 'inaccuracy';

  const colorMap = {
    blunder: '#d32f2f',
    mistake: '#e67e22',
    inaccuracy: '#c8a600',
    good: '#43a047',
    ok: '#90a4ae'
  };
  const moveColor = colorMap[label] || '#90a4ae';

  // Get coaching text for tooltips
  const exp = move.explanation;
  const whyBadText = (exp && exp.whyBad) ? exp.whyBad : null;
  const betterText = (exp && exp.betterMove) ? exp.betterMove : null;

  // Highlight from/to squares
  highlightSquare(playedFrom, moveColor, 0.25, boardSize);
  highlightSquare(playedTo, moveColor, 0.35, boardSize);

  const playedFrom_px = squareToPixel(playedFrom, boardSize);
  const playedTo_px = squareToPixel(playedTo, boardSize);

  // Draw played move arrow immediately
  drawArrow(playedFrom, playedTo, moveColor, isBad ? 0.8 : 0.4, boardSize,
    whyBadText ? { text: whyBadText, type: 'played' } : null);

  // Auto-show played-move tooltip for bad moves
  if (isBad && whyBadText) {
    const midX = (playedFrom_px.x + playedTo_px.x) / 2;
    const midY = Math.min(playedFrom_px.y, playedTo_px.y);
    const t1 = setTimeout(() => {
      if (currentPly !== move.ply) return;
      showArrowTooltip(whyBadText, midX, midY, 'played');
    }, 400);
    autoTooltipTimers.push(t1);
  }

  // Correction arrow: fade in after delay, rewind board to pre-move position
  if (isBad && move.bestMove) {
    const bestUci = sanToSquares(move, currentPly);
    if (bestUci) {
      const correctionDelay = whyBadText ? 3500 : 800;

      const t2 = setTimeout(() => {
        if (currentPly !== move.ply || userInteractedWithTooltip) return;

        // Fade out the played-move tooltip
        if (whyBadText) hideArrowTooltip();

        // Rewind board to position BEFORE the bad move
        const rewind = new Chess();
        for (let i = 0; i < currentPly - 1; i++) {
          rewind.move(analysisData[i].san);
        }
        board.position(rewind.fen(), true);

        // Clear played-move arrows, redraw from pre-move context
        if (arrowSvg) {
          while (arrowSvg.firstChild) arrowSvg.removeChild(arrowSvg.firstChild);
        }

        // Re-get board size (in case of layout shift)
        const bs = boardEl.offsetWidth;

        // Draw correction arrow starting at opacity 0, then animate in
        const corrPoly = drawArrow(bestUci.from, bestUci.to, '#1b8a2f', 0, bs,
          betterText ? { text: betterText, type: 'best' } : null);

        if (corrPoly) {
          const targetOpacity = 0.6;
          const steps = 20;
          const stepMs = 25;
          let step = 0;
          const fadeInterval = setInterval(() => {
            step++;
            corrPoly.setAttribute('fill-opacity', targetOpacity * (step / steps));
            if (step >= steps) {
              clearInterval(fadeInterval);
              corrPoly.setAttribute('fill-opacity', targetOpacity);
            }
          }, stepMs);
          autoTooltipTimers.push(fadeInterval);

          // Auto-show correction tooltip after arrow finishes fading in
          if (betterText) {
            const bestFrom_px = squareToPixel(bestUci.from, bs);
            const bestTo_px = squareToPixel(bestUci.to, bs);
            const bestMidX = (bestFrom_px.x + bestTo_px.x) / 2;
            const bestMidY = Math.min(bestFrom_px.y, bestTo_px.y);
            const t3 = setTimeout(() => {
              if (currentPly !== move.ply || userInteractedWithTooltip) return;
              showArrowTooltip(betterText, bestMidX, bestMidY, 'best');
            }, 600);
            autoTooltipTimers.push(t3);
            // Fade out correction tooltip after 4s, then restore board position
            const t4 = setTimeout(() => {
              if (currentPly !== move.ply) return;
              if (!userInteractedWithTooltip) {
                hideArrowTooltip();
              }
              // Restore board to post-move position
              const restore = new Chess();
              for (let i = 0; i < currentPly; i++) {
                restore.move(analysisData[i].san);
              }
              board.position(restore.fen(), true);
              // Redraw the played-move arrows
              setTimeout(() => {
                if (currentPly === move.ply) drawArrowsForPlyStatic();
              }, 170);
            }, 5200);
            autoTooltipTimers.push(t4);
          }
        }
      }, correctionDelay);
      autoTooltipTimers.push(t2);
    }
  } else if (isBad && whyBadText) {
    // No best move, just fade out played tooltip
    autoTooltipTimers.push(fadeOutArrowTooltip(4500));
  }
}

// Static version of arrow drawing (no auto-tooltip sequence, just draws arrows)
function drawArrowsForPlyStatic() {
  if (!arrowSvg) return;
  while (arrowSvg.firstChild) arrowSvg.removeChild(arrowSvg.firstChild);
  // Don't call hideArrowTooltip or cancelAutoTooltips here

  if (currentPly === 0) return;
  const move = analysisData[currentPly - 1];
  if (!move || !move.uci || move.uci.length < 4) return;

  const boardEl = document.getElementById('board');
  if (!boardEl) return;
  const boardSize = boardEl.offsetWidth;

  const playedFrom = move.uci.slice(0, 2);
  const playedTo = move.uci.slice(2, 4);
  const label = move.label || 'ok';
  const isBad = label === 'blunder' || label === 'mistake' || label === 'inaccuracy';

  const colorMap = {
    blunder: '#d32f2f',
    mistake: '#e67e22',
    inaccuracy: '#c8a600',
    good: '#43a047',
    ok: '#90a4ae'
  };
  const moveColor = colorMap[label] || '#90a4ae';

  const exp = move.explanation;
  const whyBadText = (exp && exp.whyBad) ? exp.whyBad : null;
  const betterText = (exp && exp.betterMove) ? exp.betterMove : null;

  highlightSquare(playedFrom, moveColor, 0.25, boardSize);
  highlightSquare(playedTo, moveColor, 0.35, boardSize);

  if (isBad && move.bestMove) {
    const bestUci = sanToSquares(move, currentPly);
    if (bestUci) {
      drawArrow(bestUci.from, bestUci.to, '#1b8a2f', 0.6, boardSize,
        betterText ? { text: betterText, type: 'best' } : null);
    }
  }

  drawArrow(playedFrom, playedTo, moveColor, isBad ? 0.8 : 0.4, boardSize,
    whyBadText ? { text: whyBadText, type: 'played' } : null);
}

function sanToSquares(move, ply) {
  try {
    const chess = new Chess();
    for (let i = 0; i < ply - 1; i++) {
      chess.move(analysisData[i].san);
    }
    const result = chess.move(move.bestMove, { sloppy: true });
    if (result) return { from: result.from, to: result.to };
  } catch (e) { /* ignore */ }
  return null;
}

window.addEventListener('resize', () => {
  if (currentPly > 0) drawArrowsForPlyStatic();
});

// ── Events ──
sampleBtn.addEventListener('click', () => { pgnInput.value = samplePgn; });

newAnalysisBtn.addEventListener('click', () => {
  resetToInput();
});

function resetToInput() {
  isAnalyzing = false;
  analyzeBtn.disabled = false;
  analysisSection.style.display = 'none';
  progressSection.style.display = 'none';
  inputPanel.style.display = '';
  inputPanel.style.removeProperty('display');
  statusEl.textContent = '';
  gameUrlInput.value = '';
  gameMoves = [];
  analysisData = [];
  currentPly = 0;
  boardFlipped = false;
  if (board) { board.destroy(); board = null; }
}

analyzeBtn.addEventListener('click', async () => {
  const url = gameUrlInput.value.trim();
  const pgn = pgnInput.value.trim();

  if (!url && !pgn) {
    statusEl.textContent = 'Paste a game URL or PGN first.';
    return;
  }

  // If URL is provided, import first
  if (url) {
    statusEl.textContent = 'Importing game...';
    analyzeBtn.disabled = true;
    try {
      const resp = await fetch('/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await resp.json();
      if (!resp.ok || !data.pgn) {
        statusEl.textContent = data.error || 'Import failed.';
        analyzeBtn.disabled = false;
        return;
      }
      // Fill PGN field and continue to analysis
      pgnInput.value = data.pgn;
      startWithPgn(data.pgn);
    } catch (err) {
      statusEl.textContent = 'Import failed: ' + err.message;
      analyzeBtn.disabled = false;
    }
    return;
  }

  // Direct PGN
  startWithPgn(pgn);
});

function startWithPgn(pgn) {
  const localMoves = parsePgnLocally(pgn);
  if (!localMoves) {
    statusEl.textContent = 'Could not parse PGN.';
    analyzeBtn.disabled = false;
    return;
  }

  gameMoves = localMoves;
  analysisData = localMoves.map((m) => ({
    ...m,
    evalBefore: null,
    evalAfter: null,
    deltaCp: null,
    label: null,
    bestMove: null,
    pv: null,
    explanation: null
  }));

  // Extract opening name from PGN headers
  const openingEl = document.getElementById('openingName');
  if (openingEl) {
    const opening = extractHeader(pgn, 'Opening') || extractHeader(pgn, 'ECO') || '';
    openingEl.textContent = opening;
  }

  showAnalysisView();
  goToPly(0);
  startAnalysisStream(pgn);
}

function extractHeader(pgn, key) {
  const re = new RegExp('\\[' + key + '\\s+"([^"]*)"\\]');
  const m = pgn.match(re);
  return m ? m[1] : '';
}

// ── Local PGN parsing ──
function parsePgnLocally(pgn) {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn, { sloppy: true });
    const history = chess.history({ verbose: true });
    if (!history.length) return null;

    return history.map((move, i) => ({
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      mover: i % 2 === 0 ? 'White' : 'Black',
      san: move.san,
      uci: move.from + move.to + (move.promotion || '')
    }));
  } catch (err) {
    return null;
  }
}

// ── Show analysis view ──
function showAnalysisView() {
  inputPanel.style.display = 'none';
  analysisSection.style.display = '';
  summaryPanel.innerHTML = '';
  progressSection.style.display = '';
  initBoard();
  renderMoveList();
}

// ── SSE streaming ──
function startAnalysisStream(pgn) {
  isAnalyzing = true;
  analyzeBtn.disabled = true;
  setProgress(0, 'Starting analysis...');

  // Use fetch + ReadableStream to handle POST SSE (EventSource only supports GET)
  fetch('/analyze-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pgn })
  }).then((response) => {
    if (!response.ok) throw new Error('Analysis request failed.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function pump() {
      return reader.read().then(({ done, value }) => {
        if (done) {
          onStreamEnd();
          return;
        }
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              handleSSE(eventType, data);
            } catch (e) { /* skip bad JSON */ }
            eventType = null;
          }
        }

        return pump();
      });
    }

    return pump();
  }).catch((err) => {
    setProgress(0, 'Error: ' + err.message);
    isAnalyzing = false;
    analyzeBtn.disabled = false;
  });
}

function handleSSE(event, data) {
  switch (event) {
    case 'phase':
      if (data.phase === 'stockfish') {
        setProgress(0, `Evaluating positions... 0/${data.total}`);
      } else if (data.phase === 'coaching') {
        setProgress(80, `Coaching moves... 0/${data.total}`);
      }
      break;

    case 'stockfish': {
      const pct = Math.round((data.current / data.total) * 75);
      setProgress(pct, `Evaluating positions... ${data.current}/${data.total}`);
      break;
    }

    case 'move':
      // Update the analysis data for this ply with eval info
      updateMoveData(data);
      break;

    case 'coach': {
      // Update coaching for a specific ply
      const idx = analysisData.findIndex((m) => m.ply === data.ply);
      if (idx !== -1) {
        analysisData[idx].explanation = data.explanation;
        // If user is viewing this move, refresh coach panel
        if (currentPly === data.ply) updateCoachPanel();
      }
      const pct = 80 + Math.round((data.current / data.total) * 20);
      setProgress(pct, `Coaching moves... ${data.current}/${data.total}`);
      break;
    }

    case 'done':
      onStreamEnd();
      break;

    case 'error':
      setProgress(0, 'Error: ' + (data.error || 'Analysis failed.'));
      isAnalyzing = false;
      analyzeBtn.disabled = false;
      break;
  }
}

function updateMoveData(serverMove) {
  const idx = analysisData.findIndex((m) => m.ply === serverMove.ply);
  if (idx === -1) return;

  // Merge server data into our local entry
  analysisData[idx] = { ...analysisData[idx], ...serverMove };

  // Re-render the move list to show labels
  renderMoveList();

  // If user is viewing this move, update eval bar and coach panel
  if (currentPly === serverMove.ply) {
    updateEvalBar();
    updateCoachPanel();
  }
}

function onStreamEnd() {
  isAnalyzing = false;
  analyzeBtn.disabled = false;
  progressSection.style.display = 'none';
  renderSummary();
  renderMoveList();
  // Refresh current view
  if (currentPly > 0) {
    updateEvalBar();
    updateCoachPanel();
  }
}

function setProgress(pct, text) {
  if (progressBar) progressBar.style.width = pct + '%';
  if (progressText) progressText.textContent = text;
}

// ── Navigation ──
document.getElementById('navStart').addEventListener('click', () => goToPly(0));
document.getElementById('navPrev').addEventListener('click', () => goToPly(currentPly - 1));
document.getElementById('navNext').addEventListener('click', () => goToPly(currentPly + 1));
document.getElementById('navEnd').addEventListener('click', () => goToPly(analysisData.length));

document.getElementById('flipBtn').addEventListener('click', () => {
  boardFlipped = !boardFlipped;
  if (board) board.flip();
  // Redraw arrows for new orientation
  cancelAutoTooltips();
  hideArrowTooltip();
  drawArrowsForPlyStatic();
});

document.addEventListener('keydown', (e) => {
  if (!analysisData.length) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goToPly(currentPly - 1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); goToPly(currentPly + 1); }
  if (e.key === 'Home') { e.preventDefault(); goToPly(0); }
  if (e.key === 'End') { e.preventDefault(); goToPly(analysisData.length); }
});

// Filters
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    moveFilter = btn.dataset.filter;
    renderMoveList();
  });
});

function goToPly(ply) {
  ply = Math.max(0, Math.min(ply, analysisData.length));
  currentPly = ply;

  const replay = new Chess();
  for (let i = 0; i < ply; i++) {
    replay.move(analysisData[i].san);
  }

  board.position(replay.fen(), true);
  // Draw arrows after piece animation finishes
  setTimeout(drawArrowsForPly, 170);
  updateEvalBar();
  updateCoachPanel();
  highlightCurrentMove();
}

function highlightCurrentMove() {
  moveListEl.querySelectorAll('.move-cell').forEach((el) => {
    el.classList.toggle('active-move', parseInt(el.dataset.ply, 10) === currentPly);
  });
  const active = moveListEl.querySelector('.active-move');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}


// ── Helpers ──
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function labelIcon(label) {
  if (!label) return '';
  const icons = {
    blunder: '<span class="move-icon blunder">??</span>',
    mistake: '<span class="move-icon mistake">?</span>',
    inaccuracy: '<span class="move-icon inaccuracy">?!</span>',
    good: '<span class="move-icon good">!</span>'
  };
  return icons[label] || '';
}

function labelClass(label) {
  if (!label) return '';
  const classes = { blunder: 'move-blunder', mistake: 'move-mistake', inaccuracy: 'move-inaccuracy' };
  return classes[label] || '';
}

// ── Render move list ──
function renderMoveList() {
  let html = '';
  const filtered = analysisData.filter((m) => {
    if (moveFilter === 'all') return true;
    return m.label === 'blunder' || m.label === 'mistake' || m.label === 'inaccuracy';
  });

  // Group by move number
  const groups = {};
  for (const m of filtered) {
    if (!groups[m.moveNumber]) groups[m.moveNumber] = {};
    if (m.mover === 'White') groups[m.moveNumber].white = m;
    else groups[m.moveNumber].black = m;
  }

  for (const num of Object.keys(groups).sort((a, b) => a - b)) {
    const g = groups[num];
    html += `<div class="move-row">`;
    html += `<span class="move-num">${num}.</span>`;
    html += moveCell(g.white);
    html += moveCell(g.black);
    html += `</div>`;
  }

  moveListEl.innerHTML = html;

  // Attach click handlers
  moveListEl.querySelectorAll('.move-cell[data-ply]').forEach((el) => {
    el.addEventListener('click', () => {
      const ply = parseInt(el.dataset.ply, 10);
      if (!isNaN(ply)) goToPly(ply);
    });
  });

  highlightCurrentMove();
}

function moveCell(move) {
  if (!move) return '<span class="move-cell empty"></span>';
  const cls = labelClass(move.label);
  const icon = labelIcon(move.label);
  const active = move.ply === currentPly ? ' active-move' : '';
  return `<span class="move-cell ${cls}${active}" data-ply="${move.ply}">${escapeHtml(move.san)}${icon}</span>`;
}

// ── Render summary ──
function renderSummary() {
  const white = { blunders: 0, mistakes: 0, inaccuracies: 0, total: 0 };
  const black = { blunders: 0, mistakes: 0, inaccuracies: 0, total: 0 };

  for (const m of analysisData) {
    const side = m.mover === 'White' ? white : black;
    side.total++;
    if (m.label === 'blunder') side.blunders++;
    else if (m.label === 'mistake') side.mistakes++;
    else if (m.label === 'inaccuracy') side.inaccuracies++;
  }

  function accuracy(s) {
    if (!s.total) return '—';
    const issues = s.blunders * 3 + s.mistakes * 2 + s.inaccuracies;
    const maxPenalty = s.total * 3;
    return Math.max(0, Math.round(((maxPenalty - issues) / maxPenalty) * 100)) + '%';
  }

  function badges(s) {
    let h = '';
    if (s.blunders) h += `<span class="badge badge-blunder">${s.blunders}</span>`;
    if (s.mistakes) h += `<span class="badge badge-mistake">${s.mistakes}</span>`;
    if (s.inaccuracies) h += `<span class="badge badge-inaccuracy">${s.inaccuracies}</span>`;
    return h;
  }

  summaryPanel.innerHTML = `
    <div class="sum-side">
      <span class="sum-label">White</span>
      <span class="sum-acc">${accuracy(white)}</span>
      <span class="sum-badges">${badges(white)}</span>
    </div>
    <div class="sum-side">
      <span class="sum-label">Black</span>
      <span class="sum-acc">${accuracy(black)}</span>
      <span class="sum-badges">${badges(black)}</span>
    </div>
  `;
}

// ── Eval bar ──
function updateEvalBar() {
  if (currentPly === 0) {
    evalFill.style.height = '50%';
    evalLabel.textContent = '0.00';
    return;
  }

  const move = analysisData[currentPly - 1];
  if (!move || move.evalAfter === null) {
    evalFill.style.height = '50%';
    evalLabel.textContent = '—';
    return;
  }

  const evalStr = move.evalAfter;
  let cp;
  if (typeof evalStr === 'string' && evalStr.startsWith('M')) {
    const mateVal = parseInt(evalStr.slice(1), 10);
    cp = mateVal > 0 ? 10000 : -10000;
  } else {
    cp = parseFloat(evalStr) * 100;
  }

  // Sigmoid mapping: 50% at 0cp, ~95% at +400cp
  const pct = 50 + 50 * (2 / (1 + Math.exp(-cp / 200)) - 1);
  const clamped = Math.max(2, Math.min(98, pct));
  evalFill.style.height = clamped + '%';

  if (typeof evalStr === 'string' && evalStr.startsWith('M')) {
    evalLabel.textContent = evalStr;
  } else {
    evalLabel.textContent = (cp / 100).toFixed(2);
  }
}

// ── Coach panel ──
function updateCoachPanel() {
  if (currentPly === 0) {
    coachPanel.innerHTML = '<div class="coach-empty">Click a move for coaching</div>';
    return;
  }

  const move = analysisData[currentPly - 1];
  if (!move) {
    coachPanel.innerHTML = '<div class="coach-empty">Click a move for coaching</div>';
    return;
  }

  const exp = move.explanation;
  const hasCoaching = exp && exp.summary;

  let html = '<div class="coach-move-header">';
  html += `<span class="coach-move-san">${move.moveNumber}${move.mover === 'Black' ? '...' : '.'} ${escapeHtml(move.san)}</span>`;
  if (move.label) {
    const badgeClass = 'badge-' + move.label;
    html += ` <span class="badge ${badgeClass}">${move.label}</span>`;
  }
  html += '</div>';

  if (move.evalBefore !== null && move.evalAfter !== null) {
    html += `<div class="coach-eval">${escapeHtml(move.evalBefore)} → ${escapeHtml(move.evalAfter)} (${move.deltaCp > 0 ? '+' : ''}${move.deltaCp}cp)</div>`;
  }

  if (move.bestMove) {
    html += `<div class="coach-best">Best: <strong>${escapeHtml(move.bestMove)}</strong></div>`;
  }
  if (move.pv && move.pv.length) {
    const pvStr = Array.isArray(move.pv) ? move.pv.join(' ') : move.pv;
    html += `<div class="coach-pv">${escapeHtml(pvStr)}</div>`;
  }

  if (hasCoaching) {
    html += '<div class="coach-body">';
    html += `<div class="coach-summary">${escapeHtml(exp.summary)}</div>`;
    if (exp.tip) html += `<div class="coach-tip">${escapeHtml(exp.tip)}</div>`;
    if (exp.whyBad || exp.betterMove) {
      html += '<div class="coach-arrow-hint">Hover the arrows on the board for details</div>';
    }
    html += '</div>';
  } else if (isAnalyzing && (move.label === 'blunder' || move.label === 'mistake' || move.label === 'inaccuracy')) {
    html += '<div class="coach-empty">Coaching loading...</div>';
  } else if (!move.label || move.label === 'ok' || move.label === 'good') {
    html += '<div class="coach-empty">No issues with this move</div>';
  }

  coachPanel.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// SCOUT FEATURE
// ═══════════════════════════════════════════════════════════════

let scoutPlatform = 'lichess';
let scoutAllGames = [];   // raw games from server
let scoutPerfs = {};       // player ratings by time control
let scoutUsername = '';
let scoutActiveTc = 'recent';
let scoutActiveCount = 300;  // default to Last 300
let scoutAiReport = null;  // cached Gemini report

// Tab switching
document.querySelectorAll('.input-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.input-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.getElementById('analyzeTab').style.display = target === 'analyze' ? '' : 'none';
    document.getElementById('scoutTab').style.display = target === 'scout' ? '' : 'none';
    document.getElementById('trainTab').style.display = target === 'train' ? '' : 'none';
    statusEl.textContent = '';
  });
});

// Platform toggle
document.querySelectorAll('.platform-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.platform-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    scoutPlatform = btn.dataset.platform;
  });
});

// Scout button — fetch all games via SSE stream with loading overlay
document.getElementById('scoutBtn').addEventListener('click', async () => {
  const username = document.getElementById('scoutUsername').value.trim();
  if (!username) {
    statusEl.textContent = 'Enter a username.';
    return;
  }

  document.getElementById('scoutBtn').disabled = true;
  statusEl.textContent = '';
  scoutAllGames = [];
  showScoutLoading('Connecting...', 0);

  try {
    const response = await fetch('/scout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, platform: scoutPlatform })
    });

    if (!response.ok) {
      hideScoutLoading();
      statusEl.textContent = 'Scout failed.';
      document.getElementById('scoutBtn').disabled = false;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            if (eventType === 'progress') {
              // Profile = 0-5%, then each TC = equal share of 5-95%
              let pct = 0;
              if (data.step === 'profile') {
                pct = 5;
              } else if (data.total) {
                pct = 5 + Math.round(((data.current || 0) / data.total) * 90);
              }
              updateScoutLoading(data.message, pct);
            } else if (eventType === 'games') {
              // Accumulate game batches
              if (data.batch) scoutAllGames.push(...data.batch);
            } else if (eventType === 'done') {
              scoutPerfs = data.perfs || {};
              scoutUsername = username;
              scoutAiReport = null;
              scoutActiveTc = 'recent';
              scoutActiveCount = 300;
              document.querySelectorAll('#scoutTcFilter .option-btn').forEach((b) => {
                b.classList.toggle('active', b.dataset.value === 'recent');
              });
              document.querySelectorAll('#scoutCountFilter .option-btn').forEach((b) => {
                b.classList.toggle('active', b.dataset.value === '300');
              });
              updateScoutLoading('Building report...', 100);
              // Brief pause so user sees 100%
              await new Promise((r) => setTimeout(r, 400));
              hideScoutLoading();
              showScoutReport();
              finished = true;
            } else if (eventType === 'error') {
              hideScoutLoading();
              statusEl.textContent = data.error || 'Scout failed.';
              finished = true;
            }
          } catch (e) { /* skip bad JSON */ }
          eventType = null;
        }
      }
    }
  } catch (err) {
    hideScoutLoading();
    statusEl.textContent = 'Scout failed: ' + err.message;
  }
  document.getElementById('scoutBtn').disabled = false;
});

// ── Scout loading overlay helpers ──
let scoutLoadingTarget = 0;   // real target percentage from SSE events
let scoutLoadingCurrent = 0;  // displayed percentage (creeps toward target)
let scoutLoadingTimer = null;

function showScoutLoading(text, pct) {
  const overlay = document.getElementById('scoutLoading');
  overlay.style.display = '';
  scoutLoadingTarget = pct || 0;
  scoutLoadingCurrent = 0;
  renderScoutLoadingPct(0);
  document.getElementById('scoutLoadingText').textContent = text || 'Preparing scout...';
  document.getElementById('scoutLoadingFill').style.width = '0%';
  startScoutLoadingTicker();
}

function updateScoutLoading(message, pct) {
  scoutLoadingTarget = Math.min(100, pct || 0);
  document.getElementById('scoutLoadingText').textContent = message;
}

function hideScoutLoading() {
  stopScoutLoadingTicker();
  document.getElementById('scoutLoading').style.display = 'none';
}

function renderScoutLoadingPct(val) {
  const rounded = Math.round(val);
  document.getElementById('scoutLoadingPct').textContent = rounded + '%';
  document.getElementById('scoutLoadingFill').style.width = rounded + '%';
}

function startScoutLoadingTicker() {
  stopScoutLoadingTicker();
  scoutLoadingTimer = setInterval(() => {
    if (scoutLoadingCurrent >= 100) { stopScoutLoadingTicker(); return; }

    const gap = scoutLoadingTarget - scoutLoadingCurrent;
    if (gap > 1) {
      // Jump a fraction of the gap — fast at first, slows as it approaches
      scoutLoadingCurrent += Math.max(0.3, gap * 0.12);
    } else if (scoutLoadingCurrent < scoutLoadingTarget) {
      // Close the last bit
      scoutLoadingCurrent = scoutLoadingTarget;
    } else {
      // Creep slowly past current target (fake progress between real events)
      // Slow down as we get closer to the next likely checkpoint
      const nextCheckpoint = scoutLoadingTarget + 30;
      const room = nextCheckpoint - scoutLoadingCurrent;
      const creep = Math.max(0.08, room * 0.015);
      scoutLoadingCurrent = Math.min(scoutLoadingCurrent + creep, scoutLoadingTarget + 25);
    }

    scoutLoadingCurrent = Math.min(scoutLoadingCurrent, 100);
    renderScoutLoadingPct(scoutLoadingCurrent);
  }, 180);
}

function stopScoutLoadingTicker() {
  if (scoutLoadingTimer) { clearInterval(scoutLoadingTimer); scoutLoadingTimer = null; }
}

// Back button
document.getElementById('scoutBackBtn').addEventListener('click', () => {
  document.getElementById('scoutSection').style.display = 'none';
  inputPanel.style.display = '';
  statusEl.textContent = '';
});

// Report page filter: time control
document.querySelectorAll('#scoutTcFilter .option-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#scoutTcFilter .option-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    scoutActiveTc = btn.dataset.value;
    scoutAiReport = null; // invalidate cached report on filter change
    renderScoutStats();
  });
});

// Report page filter: game count
document.querySelectorAll('#scoutCountFilter .option-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#scoutCountFilter .option-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    scoutActiveCount = parseInt(btn.dataset.value, 10);
    scoutAiReport = null;
    renderScoutStats();
  });
});

// AI Report button
const aiReportIcon = '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px"><path fill="currentColor" d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25zM19 15l-1.25 2.75L15 19l2.75 1.25L19 23l1.25-2.75L23 19l-2.75-1.25zM11.5 9.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12z"/></svg>';



document.getElementById('aiReportBtn').addEventListener('click', async () => {
  const btn = document.getElementById('aiReportBtn');
  btn.disabled = true;
  btn.classList.add('ai-btn-generating');
  btn.innerHTML = '<span class="ai-sparkle-spin">' + aiReportIcon + '</span> <span class="ai-btn-loading">Analyzing<span class="dot-pulse"></span></span>';

  // No scroll yet — wait until report is ready

  try {
    const games = getFilteredScoutGames();
    const stats = aggregateScoutStats(games);
    const resp = await fetch('/scout-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stats, username: scoutUsername, timeControl: scoutActiveTc })
    });
    const data = await resp.json();
    if (resp.ok && data.report) {
      scoutAiReport = data.report;
      renderScoutStats();
      // Auto-scroll to the rendered report
      setTimeout(() => {
        const sections = document.getElementById('scoutReportSections');
        if (sections) sections.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    }
  } catch (err) {
    // Remove skeleton on failure
    const container = document.getElementById('scoutReportSections');
    if (container) container.innerHTML = '<div class="scout-section" style="text-align:center;color:var(--text2);padding:20px;">Report generation failed. Try again.</div>';
  }

  btn.disabled = false;
  btn.classList.remove('ai-btn-generating');
  btn.innerHTML = aiReportIcon + ' AI Report';
});

// ── Client-side filtering + aggregation ──

function getFilteredScoutGames() {
  let games = scoutAllGames;

  // "recent" and "all" both include all TCs; bullet/blitz/rapid filter by TC
  if (scoutActiveTc !== 'all' && scoutActiveTc !== 'recent') {
    games = games.filter((g) => g.timeControl === scoutActiveTc);
  }

  // "recent" sorts by date (newest first) then takes the count limit
  // Games should already be sorted newest-first, but ensure it
  if (scoutActiveTc === 'recent') {
    games = [...games].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }

  // Limit by count
  if (scoutActiveCount > 0 && games.length > scoutActiveCount) {
    games = games.slice(0, scoutActiveCount);
  }

  return games;
}

function aggregateScoutStats(games) {
  const stats = {
    username: scoutUsername,
    totalGames: games.length,
    overall: { wins: 0, losses: 0, draws: 0 },
    byColor: {
      white: { wins: 0, losses: 0, draws: 0, total: 0 },
      black: { wins: 0, losses: 0, draws: 0, total: 0 }
    },
    openings: {},
    howTheyLose: { mate: 0, resign: 0, timeout: 0, other: 0 },
    howTheyWin: { mate: 0, resign: 0, timeout: 0, other: 0 },
    byTimeControl: {},
    opponents: {},
    ratings: [],
    avgMoveCount: 0
  };

  let totalMoves = 0;

  for (const g of games) {
    if (g.result === 'win') stats.overall.wins++;
    else if (g.result === 'loss') stats.overall.losses++;
    else stats.overall.draws++;

    const cs = stats.byColor[g.color];
    if (cs) {
      cs.total++;
      if (g.result === 'win') cs.wins++;
      else if (g.result === 'loss') cs.losses++;
      else cs.draws++;
    }

    const opName = g.opening || g.eco || 'Unknown';
    if (!stats.openings[opName]) stats.openings[opName] = { wins: 0, losses: 0, draws: 0, total: 0 };
    stats.openings[opName].total++;
    if (g.result === 'win') stats.openings[opName].wins++;
    else if (g.result === 'loss') stats.openings[opName].losses++;
    else stats.openings[opName].draws++;

    if (g.result === 'loss') {
      if (g.termination === 'mate') stats.howTheyLose.mate++;
      else if (g.termination === 'resign') stats.howTheyLose.resign++;
      else if (g.termination === 'outoftime') stats.howTheyLose.timeout++;
      else stats.howTheyLose.other++;
    }
    if (g.result === 'win') {
      if (g.termination === 'mate') stats.howTheyWin.mate++;
      else if (g.termination === 'resign') stats.howTheyWin.resign++;
      else if (g.termination === 'outoftime') stats.howTheyWin.timeout++;
      else stats.howTheyWin.other++;
    }

    const tc = g.timeControl || 'unknown';
    if (!stats.byTimeControl[tc]) stats.byTimeControl[tc] = { wins: 0, losses: 0, draws: 0, total: 0 };
    stats.byTimeControl[tc].total++;
    if (g.result === 'win') stats.byTimeControl[tc].wins++;
    else if (g.result === 'loss') stats.byTimeControl[tc].losses++;
    else stats.byTimeControl[tc].draws++;

    if (g.playerRating) stats.ratings.push(g.playerRating);
    totalMoves += g.moves || 0;

    // Track per-opponent record
    const opp = g.opponentName || 'Anonymous';
    if (opp !== 'Anonymous') {
      if (!stats.opponents[opp]) stats.opponents[opp] = { wins: 0, losses: 0, draws: 0, total: 0 };
      stats.opponents[opp].total++;
      if (g.result === 'win') stats.opponents[opp].wins++;
      else if (g.result === 'loss') stats.opponents[opp].losses++;
      else stats.opponents[opp].draws++;
    }
  }

  stats.avgMoveCount = games.length ? Math.round(totalMoves / games.length) : 0;
  return stats;
}

// ── Show scout report page ──

function showScoutReport() {
  inputPanel.style.display = 'none';
  document.getElementById('scoutSection').style.display = '';
  renderScoutStats();
}

function renderScoutStats() {
  const games = getFilteredScoutGames();
  const stats = aggregateScoutStats(games);
  const content = document.getElementById('scoutContent');

  // Pick the right rating
  let currentRating = '—';
  if (scoutActiveTc !== 'all' && scoutActiveTc !== 'recent' && scoutPerfs[scoutActiveTc]) {
    currentRating = scoutPerfs[scoutActiveTc];
  } else if (scoutPerfs.rapid) {
    currentRating = scoutPerfs.rapid;
  } else if (scoutPerfs.blitz) {
    currentRating = scoutPerfs.blitz;
  } else if (stats.ratings.length) {
    currentRating = stats.ratings[0];
  }

  const overallWR = stats.totalGames ? Math.round((stats.overall.wins / stats.totalGames) * 100) : 0;
  const whiteWR = stats.byColor.white.total ? Math.round((stats.byColor.white.wins / stats.byColor.white.total) * 100) : 0;
  const blackWR = stats.byColor.black.total ? Math.round((stats.byColor.black.wins / stats.byColor.black.total) * 100) : 0;

  if (!games.length) {
    content.innerHTML = '<div class="coach-empty" style="text-align:center;padding:40px 0;">No games found for this filter combination.</div>';
    return;
  }

  const tcLabel = scoutActiveTc === 'recent' ? 'Recent' : scoutActiveTc === 'all' ? 'All Time Controls' : scoutActiveTc.charAt(0).toUpperCase() + scoutActiveTc.slice(1);
  const countLabel = scoutActiveCount > 0 ? `Last ${scoutActiveCount}` : 'All';

  let html = '';

  // ── Hero card with donut ring ──
  const winPct = stats.totalGames ? (stats.overall.wins / stats.totalGames) * 100 : 0;
  const drawPct = stats.totalGames ? (stats.overall.draws / stats.totalGames) * 100 : 0;
  const lossPct = 100 - winPct - drawPct;

  const r = 44;
  const circ = 2 * Math.PI * r;
  const winArc = (winPct / 100) * circ;
  const drawArc = (drawPct / 100) * circ;
  const lossArc = (lossPct / 100) * circ;

  html += '<div class="scout-hero">';
  html += '<div class="scout-hero-ring">';
  html += `<svg viewBox="0 0 100 100">`;
  html += `<circle cx="50" cy="50" r="${r}" fill="none" stroke="#36322c" stroke-width="10"/>`;
  // Win arc
  html += `<circle cx="50" cy="50" r="${r}" fill="none" stroke="#7fad39" stroke-width="10" stroke-dasharray="${winArc} ${circ - winArc}" stroke-dashoffset="0" stroke-linecap="round"/>`;
  // Draw arc
  html += `<circle cx="50" cy="50" r="${r}" fill="none" stroke="#9e9889" stroke-width="10" stroke-dasharray="${drawArc} ${circ - drawArc}" stroke-dashoffset="${-winArc}" stroke-linecap="round"/>`;
  // Loss arc
  html += `<circle cx="50" cy="50" r="${r}" fill="none" stroke="#e74c3c" stroke-width="10" stroke-dasharray="${lossArc} ${circ - lossArc}" stroke-dashoffset="${-(winArc + drawArc)}" stroke-linecap="round"/>`;
  html += `</svg>`;
  html += `<div class="scout-hero-ring-label"><span class="scout-hero-wr">${overallWR}%</span><span class="scout-hero-wr-sub">win rate</span></div>`;
  html += '</div>';
  html += '<div class="scout-hero-info">';
  html += `<div class="scout-hero-name">${escapeHtml(scoutUsername)} <span class="scout-hero-rating">${currentRating}</span></div>`;
  html += `<div class="scout-hero-meta">${tcLabel} · ${countLabel} · ${stats.totalGames} games</div>`;
  html += '<div class="scout-hero-wld">';
  html += `<div class="scout-hero-wld-item"><span class="dot dot-win"></span>${stats.overall.wins}W</div>`;
  html += `<div class="scout-hero-wld-item"><span class="dot dot-draw"></span>${stats.overall.draws}D</div>`;
  html += `<div class="scout-hero-wld-item"><span class="dot dot-loss"></span>${stats.overall.losses}L</div>`;
  html += '</div>';
  html += '</div>';
  html += '</div>';

  // ── WLD bar ──
  html += '<div class="scout-wld-bar">';
  html += `<div class="wld-win" style="width:${winPct}%"></div>`;
  html += `<div class="wld-draw" style="width:${drawPct}%"></div>`;
  html += `<div class="wld-loss" style="width:${lossPct}%"></div>`;
  html += '</div>';

  // ── Color cards ──
  html += '<div class="scout-color-row">';
  html += '<div class="scout-color-card">';
  html += '<div class="scout-color-piece"><svg viewBox="0 0 24 24" width="32" height="32"><path fill="#f0ece4" d="M19 22H5v-2h14v2M17.16 8.26A4.96 4.96 0 0 0 19 4c0-.55-.45-1-1-1s-1 .45-1 1a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3c0-.55-.45-1-1-1s-1 .45-1 1a4.96 4.96 0 0 0 1.84 4.26C5.15 10.5 4 13.07 4 16v2h16v-2c0-2.93-1.15-5.5-2.84-7.74z"/></svg></div>';
  html += '<div class="scout-color-info">';
  html += '<div class="scout-color-label">As White</div>';
  html += `<div class="scout-color-wr">${whiteWR}%</div>`;
  html += `<div class="scout-color-record">${stats.byColor.white.wins}W / ${stats.byColor.white.losses}L / ${stats.byColor.white.draws}D</div>`;
  html += '</div></div>';
  html += '<div class="scout-color-card">';
  html += '<div class="scout-color-piece"><svg viewBox="0 0 24 24" width="32" height="32"><path fill="#4a453d" d="M19 22H5v-2h14v2M17.16 8.26A4.96 4.96 0 0 0 19 4c0-.55-.45-1-1-1s-1 .45-1 1a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3c0-.55-.45-1-1-1s-1 .45-1 1a4.96 4.96 0 0 0 1.84 4.26C5.15 10.5 4 13.07 4 16v2h16v-2c0-2.93-1.15-5.5-2.84-7.74z"/></svg></div>';
  html += '<div class="scout-color-info">';
  html += '<div class="scout-color-label">As Black</div>';
  html += `<div class="scout-color-wr">${blackWR}%</div>`;
  html += `<div class="scout-color-record">${stats.byColor.black.wins}W / ${stats.byColor.black.losses}L / ${stats.byColor.black.draws}D</div>`;
  html += '</div></div>';
  html += '</div>';

  // ── Stats row ──
  html += '<div class="scout-stats">';
  html += scoutStat(stats.avgMoveCount, 'Avg Moves');
  const highRating = stats.ratings.length ? Math.max(...stats.ratings) : '—';
  const lowRating = stats.ratings.length ? Math.min(...stats.ratings) : '—';
  html += scoutStat(highRating, 'Peak Rating');
  html += scoutStat(lowRating, 'Low Rating');
  const tcCounts = Object.entries(stats.byTimeControl).sort((a, b) => b[1].total - a[1].total);
  const favTc = tcCounts.length ? tcCounts[0][0] : '—';
  html += scoutStat(favTc.charAt(0).toUpperCase() + favTc.slice(1), 'Fav TC');
  html += '</div>';

  // ── Rivals: Nemesis + Victim ──
  const oppEntries = Object.entries(stats.opponents).filter(([, v]) => v.total >= 2);
  const nemesis = oppEntries.filter(([, v]) => v.losses > 0).sort((a, b) => b[1].losses - a[1].losses)[0];
  const victim = oppEntries.filter(([, v]) => v.wins > 0).sort((a, b) => b[1].wins - a[1].wins)[0];

  if (nemesis || victim) {
    html += '<div class="scout-rivals">';
    if (nemesis) {
      const [nName, nRec] = nemesis;
      html += '<div class="scout-rival-card nemesis">';
      html += '<div class="rival-icon"><svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M12 2a9 9 0 0 0-9 9c0 3.07 1.64 5.64 4 7.28V20a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.72c2.36-1.64 4-4.21 4-7.28a9 9 0 0 0-9-9zm-2 15v-2h1v2H10zm3 0v-2h1v2h-1zm3.5-5.5L14 14l-2-3-2 3-2.5-2.5L9 10l1.5 1.5L12 9l1.5 2.5L15 10l1.5 1.5z"/></svg></div>';
      html += '<div class="rival-info">';
      html += `<div class="rival-label">Nemesis</div>`;
      html += `<div class="rival-name">${escapeHtml(nName)}</div>`;
      html += `<div class="rival-record">You: ${nRec.wins}W / ${nRec.losses}L / ${nRec.draws}D</div>`;
      html += '</div></div>';
    }
    if (victim) {
      const [vName, vRec] = victim;
      html += '<div class="scout-rival-card victim">';
      html += '<div class="rival-icon"><svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm0 10c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg></div>';
      html += '<div class="rival-info">';
      html += `<div class="rival-label">Favorite Victim</div>`;
      html += `<div class="rival-name">${escapeHtml(vName)}</div>`;
      html += `<div class="rival-record">You: ${vRec.wins}W / ${vRec.losses}L / ${vRec.draws}D</div>`;
      html += '</div></div>';
    }
    html += '</div>';
  }

  // ── Two-column: Openings + Breakdown ──
  const openings = Object.entries(stats.openings)
    .filter(([, v]) => v.total >= 2)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10);

  html += '<div class="scout-two-col">';

  // Openings
  html += '<div class="scout-openings">';
  html += '<h3>Opening Repertoire</h3>';
  if (openings.length) {
    for (const [name, o] of openings) {
      const wr = o.total ? Math.round((o.wins / o.total) * 100) : 0;
      const wrClass = wr >= 60 ? 'good' : wr <= 40 ? 'bad' : 'mid';
      html += `<div class="scout-opening-row">`;
      html += `<span class="scout-opening-name">${escapeHtml(name)}</span>`;
      html += `<span class="scout-opening-record">${o.wins}W/${o.losses}L/${o.draws}D</span>`;
      html += `<span class="scout-opening-wr ${wrClass}">${wr}%</span>`;
      html += `</div>`;
    }
  } else {
    html += '<div style="color:var(--text2);font-size:0.85rem;padding:8px 0;">Not enough repeated openings.</div>';
  }
  html += '</div>';

  // Breakdown
  html += '<div style="display:flex;flex-direction:column;gap:12px;">';
  html += scoutBreakdown('How They Lose', stats.howTheyLose, stats.overall.losses, '#e74c3c');
  html += scoutBreakdown('How They Win', stats.howTheyWin, stats.overall.wins, '#7fad39');
  html += '</div>';

  html += '</div>';

  // ── AI Report sections ──
  html += '<div class="scout-report" id="scoutReportSections">';
  if (scoutAiReport) {
    html += scoutReportSection('Overview', scoutAiReport.overview);
    html += scoutReportSection('Weakest Openings', scoutAiReport.weakestOpenings);
    html += scoutReportSection('Strongest Openings', scoutAiReport.strongestOpenings);
    html += scoutReportSection('Color Weakness', scoutAiReport.colorWeakness);
    html += scoutReportSection('Tendencies', scoutAiReport.tendencies);
    html += scoutReportSection('How to Beat Them', scoutAiReport.howToBeat);
    html += scoutReportSection('Self-Improvement', scoutAiReport.selfImprovement);
  } else {
    html += '<div class="scout-section" style="text-align:center;color:var(--text2);padding:20px;">Click "AI Report" above for a detailed coaching analysis.</div>';
  }
  html += '</div>';

  // ── Watermark (visible in share image) ──
  html += '<div class="scout-watermark"><svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px"><path fill="currentColor" d="M19 22H5v-2h14v2M17.16 8.26A4.96 4.96 0 0 0 19 4c0-.55-.45-1-1-1s-1 .45-1 1a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3c0-.55-.45-1-1-1s-1 .45-1 1a4.96 4.96 0 0 0 1.84 4.26C5.15 10.5 4 13.07 4 16v2h16v-2c0-2.93-1.15-5.5-2.84-7.74z"/></svg> <span>Chessimus</span> — chessimus.com</div>';

  content.innerHTML = html;
}

function scoutStat(value, label) {
  return `<div class="scout-stat"><div class="scout-stat-value">${value}</div><div class="scout-stat-label">${label}</div></div>`;
}

function scoutBreakdown(title, data, total, color) {
  if (!total) total = 1;
  let html = `<div class="scout-breakdown-col"><h4>${title}</h4>`;
  const items = [
    ['Checkmate', data.mate],
    ['Resign', data.resign],
    ['Timeout', data.timeout],
    ['Other', data.other]
  ];
  for (const [label, count] of items) {
    const pct = Math.round((count / total) * 100) || 0;
    html += `<div class="scout-bar-row">`;
    html += `<span class="scout-bar-label">${label}</span>`;
    html += `<div class="scout-bar-track"><div class="scout-bar-fill" style="width:${pct}%;background:${color}"></div></div>`;
    html += `<span class="scout-bar-num">${count}</span>`;
    html += `</div>`;
  }
  html += '</div>';
  return html;
}

function scoutReportSection(title, body) {
  if (!body) return '';
  return `<div class="scout-section"><div class="scout-section-title">${escapeHtml(title)}</div><div class="scout-section-body">${escapeHtml(body)}</div></div>`;
}

// ── Share report as image ──
document.getElementById('shareReportBtn').addEventListener('click', async () => {
  const btn = document.getElementById('shareReportBtn');
  const shareIcon = '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11A2.99 2.99 0 0 0 21 5a3 3 0 1 0-5.91.7L8.04 9.81A2.99 2.99 0 0 0 3 12a3 3 0 0 0 5.04 2.19l7.12 4.16c-.05.2-.08.41-.08.63a2.92 2.92 0 1 0 2.92-2.9z"/></svg>';
  btn.disabled = true;
  btn.innerHTML = 'Capturing...';

  try {
    const target = document.getElementById('scoutContent');
    if (!target || typeof html2canvas === 'undefined') {
      btn.innerHTML = shareIcon + ' Share';
      btn.disabled = false;
      return;
    }

    const canvas = await html2canvas(target, {
      backgroundColor: '#1a1713',
      scale: 2,
      useCORS: true,
      logging: false
    });

    // Try native share first (mobile), fall back to download
    canvas.toBlob(async (blob) => {
      if (!blob) { btn.innerHTML = shareIcon + ' Share'; btn.disabled = false; return; }

      const file = new File([blob], `chessimus-scout-${scoutUsername}.png`, { type: 'image/png' });

      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        try {
          await navigator.share({
            title: `${scoutUsername} — Chessimus Scout Report`,
            files: [file]
          });
        } catch (e) {
          // User cancelled share, that's fine
        }
      } else {
        // Download fallback
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chessimus-scout-${scoutUsername}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }

      btn.innerHTML = shareIcon + ' Share';
      btn.disabled = false;
    }, 'image/png');
  } catch (err) {
    btn.innerHTML = shareIcon + ' Share';
    btn.disabled = false;
  }
});

// ═══════════════════════════════════════════════════════════════
// OPENING TRAINER
// ═══════════════════════════════════════════════════════════════

let trainBoard = null;
let trainRepertoire = null;   // { name, color, description, lines: [{ name, moves, explanations }] }
let trainCurrentLine = 0;
let trainMoveIndex = 0;
let trainLineStatuses = [];
let trainMistakes = 0;
let openingsDb = [];
let trainChess = null;
let trainPhase = 'demo';      // 'demo' = walkthrough, 'drill' = user plays
let trainDemoTimer = null;     // interval for demo playback

// ── Load openings database ──
fetch('/openings.json').then(r => r.json()).then(data => {
  openingsDb = data;
  initOpeningSearch();
}).catch(() => { /* openings DB failed to load */ });

function initOpeningSearch() {
  const input = document.getElementById('trainOpeningInput');
  const dropdown = document.getElementById('trainSearchResults');
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (q.length < 2) { dropdown.style.display = 'none'; return; }
    const matches = openingsDb.filter(o => o.name.toLowerCase().includes(q)).slice(0, 12);
    if (!matches.length) { dropdown.style.display = 'none'; return; }

    dropdown.innerHTML = matches.map(o =>
      `<button class="search-result-btn" data-name="${escapeHtml(o.name)}" data-pgn="${escapeHtml(o.pgn)}" data-eco="${escapeHtml(o.eco)}">`
      + `<span class="search-result-eco">${escapeHtml(o.eco)}</span>`
      + `<span class="search-result-name">${escapeHtml(o.name)}</span>`
      + `</button>`
    ).join('');
    dropdown.style.display = '';

    dropdown.querySelectorAll('.search-result-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        dropdown.style.display = 'none';
        launchTrainer(btn.dataset.name, btn.dataset.pgn);
      });
    });
  });

  input.addEventListener('focus', () => {
    if (input.value.trim().length >= 2) input.dispatchEvent(new Event('input'));
  });
  document.addEventListener('click', (e) => {
    if (!dropdown.contains(e.target) && e.target !== input) dropdown.style.display = 'none';
  });
}

// Preset buttons → launch immediately
document.querySelectorAll('.train-preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.opening;
    const match = openingsDb.find(o => o.name === name)
      || openingsDb.find(o => o.name.toLowerCase().includes(name.toLowerCase()));
    if (match) launchTrainer(match.name, match.pgn);
  });
});

// Back button
document.getElementById('trainBackBtn').addEventListener('click', () => {
  clearDemoTimer();
  document.getElementById('trainSection').style.display = 'none';
  inputPanel.style.display = '';
  statusEl.textContent = '';
  if (trainBoard) { trainBoard.destroy(); trainBoard = null; }
});

// Retry button — restart drill for current line
document.getElementById('trainRetryBtn').addEventListener('click', () => {
  if (!trainRepertoire) return;
  clearDemoTimer();
  trainPhase = 'drill';
  trainMoveIndex = 0;
  trainMistakes = 0;
  trainChess = new Chess();
  clearTrainArrows();
  if (trainBoard) trainBoard.destroy();
  trainBoard = Chessboard('trainBoard', {
    position: 'start',
    orientation: trainRepertoire.color === 'black' ? 'black' : 'white',
    pieceTheme: '/img/pieces/{piece}.png',
    draggable: true,
    onDrop: onTrainDrop,
    onSnapEnd: onTrainSnapEnd
  });
  initTrainArrowOverlay();
  updateTrainProgress();
  setTrainFeedback('info', 'Try again — play the line from memory!');
  addChatMsg('coach', 'Let\'s try again. Play the correct moves on the board.');
  if (trainRepertoire.color === 'black') {
    setTimeout(() => autoPlayOpponent(), 400);
  }
});

// Watch Demo button — replay the demo walkthrough
document.getElementById('trainWatchBtn').addEventListener('click', () => {
  if (trainRepertoire) startLineDemo(trainCurrentLine);
});

// Flip button
document.getElementById('trainFlipBtn').addEventListener('click', () => {
  if (trainBoard) trainBoard.flip();
});

// ── Build repertoire client-side from openings DB ──
function buildRepertoireFromDb(openingName, basePgn) {
  const chess = new Chess();
  const baseMoves = [];
  const tokens = basePgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    const m = chess.move(t, { sloppy: true });
    if (!m) break;
    baseMoves.push(m.san);
  }

  // Auto-detect color: if the opening name contains "Defense" or "..."/black-typical keywords, play as black
  const nameLower = openingName.toLowerCase();
  const isDefense = nameLower.includes('defense') || nameLower.includes('defence')
    || nameLower.includes('counter') || nameLower.includes('variation');
  // If the base PGN has an odd number of moves, the last move is white's → student likely plays white
  // If even, last move is black's → student likely plays black
  const color = (baseMoves.length % 2 === 0 && isDefense) ? 'black' : 'white';

  // Main line = the base moves
  const lines = [{ name: 'Main Line', moves: [...baseMoves], explanations: {} }];

  // Find sub-variations from the DB (openings that start with the same moves but go further)
  const baseKey = baseMoves.join(' ');
  const subVariations = openingsDb.filter(o => {
    if (o.name === openingName) return false;
    const oMoves = parsePgnMoves(o.pgn);
    if (oMoves.length <= baseMoves.length) return false;
    // Must share the same prefix
    for (let i = 0; i < baseMoves.length; i++) {
      if (oMoves[i] !== baseMoves[i]) return false;
    }
    return true;
  }).slice(0, 5); // max 5 sub-variations

  for (const sub of subVariations) {
    const subMoves = parsePgnMoves(sub.pgn);
    const shortName = sub.name.replace(openingName + ': ', '').replace(openingName + ', ', '');
    lines.push({ name: shortName || sub.name, moves: subMoves, explanations: {} });
  }

  return { name: openingName, color, description: '', lines };
}

function parsePgnMoves(pgn) {
  const chess = new Chess();
  const moves = [];
  const tokens = pgn.replace(/\d+\.\s*/g, '').trim().split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    // Skip result tokens
    if (t === '1-0' || t === '0-1' || t === '1/2-1/2' || t === '*') continue;
    const m = chess.move(t, { sloppy: true });
    if (!m) break;
    moves.push(m.san);
  }
  return moves;
}

// ── Launch trainer instantly ──
function launchTrainer(openingName, pgn) {
  trainRepertoire = buildRepertoireFromDb(openingName, pgn);
  if (!trainRepertoire.lines.length || !trainRepertoire.lines[0].moves.length) {
    statusEl.textContent = 'Could not parse opening moves.';
    return;
  }

  // Show training view
  inputPanel.style.display = 'none';
  document.getElementById('scoutSection').style.display = 'none';
  document.getElementById('analysisSection').style.display = 'none';
  const trainSection = document.getElementById('trainSection');
  trainSection.style.display = '';

  document.getElementById('trainOpeningName').textContent = trainRepertoire.name;
  document.getElementById('trainDescription').textContent = trainRepertoire.description || 'Practice the moves on the board. The opponent plays automatically.';

  trainLineStatuses = trainRepertoire.lines.map(() => 'pending');
  trainCurrentLine = 0;
  trainLineStatuses[0] = 'in-progress';
  renderLineSelector();

  // Init board after DOM is visible, start with demo walkthrough
  setTimeout(() => startLine(0), 80);

  // Fetch AI explanations in background (non-blocking)
  fetchExplanationsInBackground();
}

function clearDemoTimer() {
  if (trainDemoTimer) { clearTimeout(trainDemoTimer); trainDemoTimer = null; }
}

// ── Training board arrow overlay ──
let trainArrowSvg = null;
let trainBoardFlipped = false;

function initTrainArrowOverlay() {
  const old = document.getElementById('trainArrowOverlay');
  if (old) old.remove();
  const boardEl = document.getElementById('trainBoard');
  if (!boardEl) return;
  boardEl.style.position = 'relative';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'trainArrowOverlay';
  svg.setAttribute('class', 'arrow-overlay');
  boardEl.appendChild(svg);
  trainArrowSvg = svg;
  trainBoardFlipped = trainRepertoire && trainRepertoire.color === 'black';
}

function trainSquareToPixel(sq, boardSize) {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const sqSize = boardSize / 8;
  if (trainBoardFlipped) {
    return { x: (7 - file) * sqSize + sqSize / 2, y: rank * sqSize + sqSize / 2 };
  }
  return { x: file * sqSize + sqSize / 2, y: (7 - rank) * sqSize + sqSize / 2 };
}

function drawTrainArrow(fromSq, toSq, color, opacity) {
  if (!trainArrowSvg || !fromSq || !toSq || fromSq === toSq) return;
  const boardEl = document.getElementById('trainBoard');
  if (!boardEl) return;
  const boardSize = boardEl.offsetWidth;
  const from = trainSquareToPixel(fromSq, boardSize);
  const to = trainSquareToPixel(toSq, boardSize);
  const sqSize = boardSize / 8;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const ux = dx / len, uy = dy / len;
  const px = -uy, py = ux;

  const shaftW = sqSize * 0.22;
  const headW = sqSize * 0.52;
  const headL = sqSize * 0.42;
  const startOff = sqSize * 0.15;
  const sx = from.x + ux * startOff, sy = from.y + uy * startOff;
  const tipOff = sqSize * 0.1;
  const tipX = to.x - ux * tipOff, tipY = to.y - uy * tipOff;
  const bx = tipX - ux * headL, by = tipY - uy * headL;

  const pts = [
    `${sx + px * shaftW / 2},${sy + py * shaftW / 2}`,
    `${bx + px * shaftW / 2},${by + py * shaftW / 2}`,
    `${bx + px * headW / 2},${by + py * headW / 2}`,
    `${tipX},${tipY}`,
    `${bx - px * headW / 2},${by - py * headW / 2}`,
    `${bx - px * shaftW / 2},${by - py * shaftW / 2}`,
    `${sx - px * shaftW / 2},${sy - py * shaftW / 2}`
  ];

  const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', pts.join(' '));
  polygon.setAttribute('fill', color);
  polygon.setAttribute('fill-opacity', opacity);
  polygon.style.transition = 'fill-opacity 0.3s';
  trainArrowSvg.appendChild(polygon);
}

function highlightTrainSquare(sq, color, opacity) {
  if (!trainArrowSvg || !sq) return;
  const boardEl = document.getElementById('trainBoard');
  if (!boardEl) return;
  const boardSize = boardEl.offsetWidth;
  const sqSize = boardSize / 8;
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  const x = trainBoardFlipped ? (7 - file) * sqSize : file * sqSize;
  const y = trainBoardFlipped ? rank * sqSize : (7 - rank) * sqSize;

  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', x);
  rect.setAttribute('y', y);
  rect.setAttribute('width', sqSize);
  rect.setAttribute('height', sqSize);
  rect.setAttribute('fill', color);
  rect.setAttribute('fill-opacity', opacity);
  trainArrowSvg.appendChild(rect);
}

function clearTrainArrows() {
  if (!trainArrowSvg) return;
  while (trainArrowSvg.firstChild) trainArrowSvg.removeChild(trainArrowSvg.firstChild);
}

// ── On-board tooltip for training ──
let trainTooltipEl = null;

function ensureTrainTooltip() {
  if (trainTooltipEl) return trainTooltipEl;
  const el = document.createElement('div');
  el.id = 'trainBoardTooltip';
  el.className = 'arrow-tooltip arrow-tooltip-best';
  el.style.display = 'none';
  const boardEl = document.getElementById('trainBoard');
  if (boardEl) boardEl.appendChild(el);
  trainTooltipEl = el;
  return el;
}

function showTrainTooltip(text, targetSq) {
  const tip = ensureTrainTooltip();
  const boardEl = document.getElementById('trainBoard');
  if (!boardEl || !text) { hideTrainTooltip(); return; }
  tip.textContent = text;
  tip.style.display = 'block';

  const boardW = boardEl.offsetWidth;
  const boardH = boardEl.offsetHeight;

  // Measure tooltip
  tip.style.left = '0px';
  tip.style.top = '0px';
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;

  if (targetSq) {
    // Position next to the target square
    const pos = trainSquareToPixel(targetSq, boardW);
    const sqSize = boardW / 8;

    // Try placing to the right of the square
    let left = pos.x + sqSize / 2 + 8;
    let top = pos.y - tipH / 2;

    // If it overflows right, place to the left
    if (left + tipW > boardW - 4) {
      left = pos.x - sqSize / 2 - tipW - 8;
    }
    // If it still overflows left, center horizontally above/below
    if (left < 4) {
      left = Math.max(4, Math.min(pos.x - tipW / 2, boardW - tipW - 4));
      // Place above the square
      top = pos.y - sqSize / 2 - tipH - 6;
      if (top < 4) top = pos.y + sqSize / 2 + 6;
    }

    // Clamp vertically
    top = Math.max(4, Math.min(top, boardH - tipH - 4));

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  } else {
    // Fallback: bottom center
    tip.style.left = Math.max(4, (boardW - tipW) / 2) + 'px';
    tip.style.top = (boardH - tipH - 8) + 'px';
  }
}

function hideTrainTooltip() {
  if (trainTooltipEl) trainTooltipEl.style.display = 'none';
}

// ── Chat panel helpers ──
function addChatMsg(role, text) {
  const container = document.getElementById('trainChatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'train-chat-msg ' + role;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function clearChat() {
  const container = document.getElementById('trainChatMessages');
  if (container) container.innerHTML = '';
}

// Get from/to squares from a SAN move using a chess instance
function sanToFromTo(chess, san) {
  const clone = new Chess(chess.fen());
  const result = clone.move(san, { sloppy: true });
  if (result) return { from: result.from, to: result.to };
  return null;
}

// ── Demo phase: walk through the line move by move ──
function startLineDemo(lineIdx) {
  clearDemoTimer();
  trainCurrentLine = lineIdx;
  trainMoveIndex = 0;
  trainMistakes = 0;
  trainPhase = 'demo';
  trainChess = new Chess();

  if (trainBoard) trainBoard.destroy();
  trainBoard = Chessboard('trainBoard', {
    position: 'start',
    orientation: trainRepertoire.color === 'black' ? 'black' : 'white',
    pieceTheme: '/img/pieces/{piece}.png',
    draggable: false
  });
  initTrainArrowOverlay();
  trainTooltipEl = null;

  trainLineStatuses[lineIdx] = 'in-progress';
  renderLineSelector();

  const line = trainRepertoire.lines[lineIdx];
  setTrainFeedback('demo', `Watch: ${line.name}`);
  clearChat();
  addChatMsg('coach', `Let's walk through the ${line.name}. Watch the board.`);
  renderDemoMoveList(line, -1);
  updateTrainProgress();

  trainDemoTimer = setTimeout(() => demoNextMove(line), 800);
}

function demoNextMove(line) {
  if (trainPhase !== 'demo' || trainMoveIndex >= line.moves.length) {
    onDemoComplete(line);
    return;
  }

  const san = line.moves[trainMoveIndex];
  const squares = sanToFromTo(trainChess, san);
  const result = trainChess.move(san, { sloppy: true });
  if (!result) { trainMoveIndex++; demoNextMove(line); return; }

  trainBoard.position(trainChess.fen(), true);

  clearTrainArrows();
  if (squares) {
    highlightTrainSquare(squares.from, '#7fad39', 0.25);
    highlightTrainSquare(squares.to, '#7fad39', 0.3);
    drawTrainArrow(squares.from, squares.to, '#7fad39', 0.85);
  }

  const moveNum = Math.floor(trainMoveIndex / 2) + 1;
  const isWhite = trainMoveIndex % 2 === 0;
  const moveLabel = isWhite ? `${moveNum}. ${result.san}` : `${moveNum}... ${result.san}`;
  const explanation = line.explanations && line.explanations[String(trainMoveIndex + 1)];

  // Short text on the board next to the played move
  showTrainTooltip(moveLabel + (explanation ? ' — ' + explanation.split('.')[0] + '.' : ''), squares ? squares.to : null);

  // Full explanation in chat
  if (explanation) {
    addChatMsg('coach', `${moveLabel}: ${explanation}`);
  } else {
    addChatMsg('coach', moveLabel);
  }

  renderDemoMoveList(line, trainMoveIndex);
  trainMoveIndex++;
  updateTrainProgress();

  const pace = explanation ? 2800 : 1200;
  trainDemoTimer = setTimeout(() => demoNextMove(line), pace);
}

function onDemoComplete(line) {
  clearDemoTimer();
  clearTrainArrows();
  hideTrainTooltip();
  setTrainFeedback('info', 'Your turn — play the line from memory!');
  addChatMsg('coach', 'Now try it yourself! Play the moves from memory.');
  renderDemoMoveList(line, line.moves.length);

  trainDemoTimer = setTimeout(() => {
    trainPhase = 'drill';
    trainMoveIndex = 0;
    trainChess = new Chess();
    clearTrainArrows();

    if (trainBoard) trainBoard.destroy();
    trainBoard = Chessboard('trainBoard', {
      position: 'start',
      orientation: trainRepertoire.color === 'black' ? 'black' : 'white',
      pieceTheme: '/img/pieces/{piece}.png',
      draggable: true,
      onDrop: onTrainDrop,
      onSnapEnd: onTrainSnapEnd
    });
    initTrainArrowOverlay();
    trainTooltipEl = null;

    updateTrainProgress();

    if (trainRepertoire.color === 'black') {
      setTimeout(() => autoPlayOpponent(), 400);
    }
  }, 1500);
}

function renderDemoMoveList(line, highlightIdx) {
  const panel = document.getElementById('trainInfoPanel');
  let html = '<div class="demo-move-list">';
  for (let i = 0; i < line.moves.length; i++) {
    const moveNum = Math.floor(i / 2) + 1;
    const isWhite = i % 2 === 0;
    if (isWhite) html += `<span class="demo-move-num">${moveNum}.</span>`;
    const cls = i < highlightIdx ? 'demo-move played' : i === highlightIdx ? 'demo-move current' : 'demo-move upcoming';
    html += `<span class="${cls}">${escapeHtml(line.moves[i])}</span>`;
  }
  html += '</div>';
  panel.innerHTML = html;
}

// ── Drill phase (user plays) ──
function startLine(lineIdx) {
  clearDemoTimer();
  trainCurrentLine = lineIdx;
  trainLineStatuses[lineIdx] = 'in-progress';
  renderLineSelector();

  // Always start with demo walkthrough
  startLineDemo(lineIdx);
}

function onTrainDrop(source, target) {
  if (trainPhase !== 'drill') return 'snapback';
  const line = trainRepertoire.lines[trainCurrentLine];
  if (!line || trainMoveIndex >= line.moves.length) return 'snapback';

  const expectedSan = line.moves[trainMoveIndex];
  const attempt = trainChess.move({ from: source, to: target, promotion: 'q' });
  if (!attempt) return 'snapback';

  if (attempt.san === expectedSan) {
    trainMoveIndex++;
    clearTrainArrows();
    highlightTrainSquare(source, '#7fad39', 0.25);
    highlightTrainSquare(target, '#7fad39', 0.3);
    drawTrainArrow(source, target, '#7fad39', 0.85);

    const explanation = line.explanations && line.explanations[String(trainMoveIndex)];
    setTrainFeedback('correct', 'Correct! ' + attempt.san);
    showTrainTooltip(attempt.san + (explanation ? ' — ' + explanation.split('.')[0] + '.' : ''), target);
    if (explanation) addChatMsg('coach', explanation);
    updateTrainProgress();
    if (trainMoveIndex >= line.moves.length) { onLineComplete(); return; }
    setTimeout(() => {
      clearTrainArrows();
      hideTrainTooltip();
      autoPlayOpponent();
    }, 500);
  } else {
    trainChess.undo();
    trainMistakes++;
    clearTrainArrows();

    highlightTrainSquare(source, '#e74c3c', 0.2);
    highlightTrainSquare(target, '#e74c3c', 0.25);
    drawTrainArrow(source, target, '#e74c3c', 0.6);

    const correctSquares = sanToFromTo(trainChess, expectedSan);
    if (correctSquares) {
      drawTrainArrow(correctSquares.from, correctSquares.to, '#7fad39', 0.85);
    }

    setTrainFeedback('wrong', `Not quite — you played ${attempt.san}`);
    showTrainTooltip(`Try ${expectedSan} instead`, correctSquares ? correctSquares.to : target);

    const explanation = line.explanations && line.explanations[String(trainMoveIndex + 1)];
    let chatText = `You played ${attempt.san} — the correct move is ${expectedSan}.`;
    if (explanation) chatText += ` ${explanation}`;
    addChatMsg('coach', chatText);
    return 'snapback';
  }
}

function onTrainSnapEnd() {
  if (trainBoard && trainChess) trainBoard.position(trainChess.fen());
}

function autoPlayOpponent() {
  const line = trainRepertoire.lines[trainCurrentLine];
  if (!line || trainMoveIndex >= line.moves.length) return;

  const san = line.moves[trainMoveIndex];
  const squares = sanToFromTo(trainChess, san);
  const result = trainChess.move(san, { sloppy: true });
  if (!result) { trainMoveIndex++; if (trainMoveIndex >= line.moves.length) { onLineComplete(); return; } autoPlayOpponent(); return; }

  trainMoveIndex++;
  trainBoard.position(trainChess.fen(), true);

  // Show opponent's move arrow in a muted color
  clearTrainArrows();
  if (squares) {
    highlightTrainSquare(squares.from, '#8b6f47', 0.2);
    highlightTrainSquare(squares.to, '#8b6f47', 0.25);
    drawTrainArrow(squares.from, squares.to, '#8b6f47', 0.6);
  }

  if (trainMoveIndex >= line.moves.length) { onLineComplete(); return; }
  setTrainFeedback('info', 'Your move!');
}

function onLineComplete() {
  clearTrainArrows();
  hideTrainTooltip();
  trainLineStatuses[trainCurrentLine] = 'complete';
  renderLineSelector();
  updateTrainProgress();

  const m = trainMistakes;
  setTrainFeedback('complete', m === 0 ? 'Perfect! No mistakes.' : `Line done! ${m} mistake${m > 1 ? 's' : ''}.`);

  if (trainLineStatuses.every(s => s === 'complete')) {
    addChatMsg('coach', 'All lines mastered! You\'re ready to play this opening with confidence.');
    return;
  }
  const nextIdx = trainLineStatuses.findIndex(s => s !== 'complete');
  if (nextIdx !== -1) {
    addChatMsg('coach', 'Nice work! Moving to the next line...');
    setTimeout(() => startLine(nextIdx), 1500);
  }
}

function renderLineSelector() {
  const container = document.getElementById('trainLineSelector');
  if (!trainRepertoire) { container.innerHTML = ''; return; }
  container.innerHTML = trainRepertoire.lines.map((line, i) => {
    const status = trainLineStatuses[i] || 'pending';
    const active = i === trainCurrentLine ? ' active' : '';
    const label = status === 'complete' ? 'Done' : status === 'in-progress' ? 'Active' : 'Pending';
    return `<button class="train-line-btn${active}" data-line="${i}"><span>${escapeHtml(line.name)}</span><span class="line-status ${status}">${label}</span></button>`;
  }).join('');
  container.querySelectorAll('.train-line-btn').forEach(btn => {
    btn.addEventListener('click', () => { const i = parseInt(btn.dataset.line, 10); if (!isNaN(i)) startLine(i); });
  });
}

function updateTrainProgress() {
  const panel = document.getElementById('trainProgressPanel');
  if (!trainRepertoire) { panel.innerHTML = ''; return; }
  const done = trainLineStatuses.filter(s => s === 'complete').length;
  const total = trainLineStatuses.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const line = trainRepertoire.lines[trainCurrentLine];
  const phaseLabel = trainPhase === 'demo' ? 'Watching' : 'Practicing';
  panel.innerHTML = `<div class="train-progress-bar"><div class="train-progress-fill" style="width:${pct}%"></div></div>`
    + `<div class="train-progress-text">${done}/${total} lines · ${phaseLabel} · Move ${trainMoveIndex}/${line ? line.moves.length : 0}</div>`;
}

function setTrainFeedback(type, text) {
  const el = document.getElementById('trainFeedback');
  el.className = 'train-feedback ' + type;
  el.textContent = text;
}

// ── Ask question about current position ──
async function askTrainQuestion(question) {
  if (!question.trim()) return;
  addChatMsg('user', question);
  const input = document.getElementById('trainChatInput');
  if (input) input.value = '';

  const typingDiv = document.createElement('div');
  typingDiv.className = 'train-chat-msg coach typing';
  typingDiv.textContent = 'Thinking...';
  const container = document.getElementById('trainChatMessages');
  container.appendChild(typingDiv);
  container.scrollTop = container.scrollHeight;

  try {
    const line = trainRepertoire ? trainRepertoire.lines[trainCurrentLine] : null;
    const movesPlayed = line ? line.moves.slice(0, trainMoveIndex) : [];
    const resp = await fetch('/ask-opening', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opening: trainRepertoire ? trainRepertoire.name : '',
        color: trainRepertoire ? trainRepertoire.color : 'white',
        moves: movesPlayed,
        fen: trainChess ? trainChess.fen() : '',
        question
      })
    });
    typingDiv.remove();
    if (!resp.ok) { addChatMsg('coach', 'Sorry, couldn\'t process that. Try again.'); return; }
    const data = await resp.json();
    addChatMsg('coach', data.answer || 'I\'m not sure about that.');
  } catch (e) {
    typingDiv.remove();
    addChatMsg('coach', 'Connection error. Try again.');
  }
}

document.getElementById('trainChatSend').addEventListener('click', () => {
  askTrainQuestion(document.getElementById('trainChatInput').value);
});
document.getElementById('trainChatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); askTrainQuestion(e.target.value); }
});

// ── Background AI explanations (non-blocking) ──
async function fetchExplanationsInBackground() {
  if (!trainRepertoire || !trainRepertoire.lines.length) return;
  try {
    // Send the client's actual lines to the fast explain endpoint
    const linesToSend = trainRepertoire.lines.map(l => ({ name: l.name, moves: l.moves }));

    const resp = await fetch('/explain-opening', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        opening: trainRepertoire.name,
        color: trainRepertoire.color,
        lines: linesToSend
      })
    });
    if (!resp.ok) return;
    const data = await resp.json();

    // Merge description
    if (data.description) {
      trainRepertoire.description = data.description;
      const descEl = document.getElementById('trainDescription');
      if (descEl) descEl.textContent = data.description;
    }

    // Merge explanations by matching line names
    if (data.lines && data.lines.length) {
      for (let ci = 0; ci < trainRepertoire.lines.length; ci++) {
        const clientLine = trainRepertoire.lines[ci];
        // Match by index first (most reliable since we sent them in order)
        if (ci < data.lines.length && data.lines[ci].explanations) {
          clientLine.explanations = data.lines[ci].explanations;
        }
      }
    }

    // If we're currently in demo, the explanations will show on subsequent moves
    // If we're in drill, they'll show on the next correct/wrong feedback
  } catch (e) { /* AI explanations are optional */ }
}

// ── Public function for scout integration ──
function trainOpening(openingName, color) {
  const match = openingsDb.find(o => o.name.toLowerCase() === openingName.toLowerCase())
    || openingsDb.find(o => o.name.toLowerCase().includes(openingName.toLowerCase()));
  if (match) {
    launchTrainer(match.name, match.pgn);
  }
}
