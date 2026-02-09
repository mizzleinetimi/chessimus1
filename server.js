require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const readline = require('readline');

const PORT = process.env.PORT || 3000;
const STOCKFISH_PATH = process.env.STOCKFISH_PATH || 'stockfish';
const STOCKFISH_DEPTH = parseInt(process.env.STOCKFISH_DEPTH || '12', 10);
const MAX_MOVES = parseInt(process.env.MAX_MOVES || '120', 10);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || '';
const GEMINI_PRIMARY_MODEL = process.env.GEMINI_PRIMARY_MODEL || GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_TEMPERATURE = parseFloat(process.env.GEMINI_TEMPERATURE || '0.2');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

function log(level, message, meta) {
  const current = LOG_LEVELS[LOG_LEVEL] ?? LOG_LEVELS.info;
  const target = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (target > current) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (meta) {
    try {
      console.log(`${line} ${JSON.stringify(meta)}`);
    } catch (err) {
      console.log(line);
    }
  } else {
    console.log(line);
  }
}

let ChessCtor = null;
let lastGeminiError = null;
let loggedGeminiConfig = false;
function getChess() {
  if (!ChessCtor) {
    ({ Chess: ChessCtor } = require('chess.js'));
  }
  return ChessCtor;
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_SIZE = 1024 * 1024;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json'
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleAnalyze(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) {
      res.writeHead(413);
      res.end();
      req.destroy();
    }
  });

  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const pgn = parsed.pgn ? String(parsed.pgn) : '';
      if (!pgn.trim()) {
        sendJson(res, 400, { error: 'PGN is required.' });
        return;
      }
      const analysis = await analyzeGame(pgn);
      sendJson(res, 200, { analysis });
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Analysis failed.' });
    }
  });
}

async function handleAnalyzeStream(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) {
      res.writeHead(413);
      res.end();
      req.destroy();
    }
  });

  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid JSON');
      return;
    }

    const pgn = parsed.pgn ? String(parsed.pgn) : '';
    if (!pgn.trim()) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('PGN is required.');
      return;
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      await analyzeGame(pgn, (event, data) => {
        if (!res.writableEnded) send(event, data);
      });
    } catch (err) {
      send('error', { error: err.message || 'Analysis failed.' });
    }

    if (!res.writableEnded) res.end();
  });
}

async function handleImport(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) {
      res.writeHead(413);
      res.end();
      req.destroy();
    }
  });

  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch (err) {
      sendJson(res, 400, { error: 'Invalid JSON.' });
      return;
    }

    const url = parsed.url ? String(parsed.url).trim() : '';
    if (!url) {
      sendJson(res, 400, { error: 'URL is required.' });
      return;
    }

    try {
      const pgn = await fetchPgnFromUrl(url);
      if (!pgn) {
        sendJson(res, 400, { error: 'Could not fetch PGN from that URL.' });
        return;
      }
      sendJson(res, 200, { pgn });
    } catch (err) {
      log('warn', 'Import failed', { url, error: err.message });
      sendJson(res, 400, { error: err.message || 'Import failed.' });
    }
  });
}

async function fetchPgnFromUrl(url) {
  // Lichess game URL patterns:
  //   https://lichess.org/GAMEID
  //   https://lichess.org/GAMEID/black
  //   https://lichess.org/GAMEID#5
  const lichessMatch = url.match(/lichess\.org\/([a-zA-Z0-9]{8,12})(?:\/|\b|#|$|\?)/);
  if (lichessMatch) {
    // Try full ID first, then first 8 chars (Lichess standard game IDs are 8 chars)
    const fullId = lichessMatch[1];
    const ids = fullId.length > 8 ? [fullId, fullId.slice(0, 8)] : [fullId];

    for (const gameId of ids) {
      const apiUrl = `https://lichess.org/game/export/${gameId}?clocks=false&evals=false`;
      log('info', 'Importing from Lichess', { gameId });
      const resp = await fetch(apiUrl, {
        headers: { 'Accept': 'application/x-chess-pgn' }
      });
      if (resp.ok) {
        const pgn = await resp.text();
        if (pgn && pgn.length > 10) return pgn.trim();
      }
    }
    throw new Error('Could not fetch game from Lichess. Check the URL.');
  }

  // Chess.com game URLs:
  //   https://www.chess.com/game/live/123456789
  //   https://www.chess.com/game/daily/123456789
  //   https://www.chess.com/game/123456789
  //   https://www.chess.com/analysis/game/live/123456789
  const chesscomMatch = url.match(/chess\.com\/(?:analysis\/)?game\/(?:live\/|daily\/)?(\d+)/);
  if (chesscomMatch) {
    const gameId = chesscomMatch[1];
    log('info', 'Importing from Chess.com', { gameId });

    // Step 1: Get game metadata from callback API to find player + date
    let username = null;
    let gameDate = null;
    try {
      const cbResp = await fetch(`https://www.chess.com/callback/live/game/${gameId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
      });
      if (cbResp.ok) {
        const cbData = await cbResp.json();
        const headers = cbData?.game?.pgnHeaders;
        if (headers) {
          username = headers.White || headers.Black;
          gameDate = headers.Date; // "2026.02.07"
        }
      } else {
        log('debug', 'Chess.com callback failed', { status: cbResp.status });
      }
    } catch (e) {
      log('warn', 'Chess.com callback error', { error: e.message });
    }

    if (!username || !gameDate) {
      throw new Error('Could not fetch game info from Chess.com. Check the URL.');
    }

    // Step 2: Fetch from player archive using the date
    const [year, month] = gameDate.split('.');
    const archiveUrl = `https://api.chess.com/pub/player/${username}/games/${year}/${month}`;
    log('info', 'Fetching Chess.com archive', { username, year, month });

    const archResp = await fetch(archiveUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' }
    });
    if (!archResp.ok) {
      throw new Error(`Chess.com archive returned ${archResp.status}.`);
    }

    const archData = await archResp.json();
    const games = archData.games || [];
    const target = games.find((g) => g.url && g.url.includes(gameId));
    if (target && target.pgn) {
      return target.pgn.trim();
    }

    throw new Error('Game found but PGN not available. It may still be processing.');
  }

  throw new Error('Unsupported URL. Paste a Lichess or Chess.com game link.');
}

// ═══════════════════════════════════════════════════════════════
// SCOUT FEATURE
// ═══════════════════════════════════════════════════════════════

async function handleScout(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Invalid JSON');
      return;
    }

    const { username, platform } = parsed;
    if (!username || !platform) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Username and platform required.');
      return;
    }

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const send = (event, data) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    log('info', 'Scout request', { username, platform });

    const uTrimmed = username.trim();
    const pLower = platform.toLowerCase();

    let games = [];
    let profile = null;

    try {
      if (pLower === 'lichess') {
        const perTc = ['bullet', 'blitz', 'rapid'];
        send('progress', { step: 'profile', message: 'Fetching player profile...' });
        profile = await fetchPlayerProfile(uTrimmed, pLower);
        send('progress', { step: 'profile', message: 'Profile loaded' });

        for (let i = 0; i < perTc.length; i++) {
          const tc = perTc[i];
          send('progress', { step: tc, message: `Fetching ${tc} games...`, current: i, total: perTc.length });
          try {
            const tcGames = await fetchPlayerGames(uTrimmed, pLower, 500, tc);
            games.push(...tcGames);
            send('progress', { step: tc, message: `${tcGames.length} ${tc} games loaded`, current: i + 1, total: perTc.length, count: tcGames.length });
          } catch (e) {
            log('warn', 'TC fetch failed', { tc, error: e.message });
            send('progress', { step: tc, message: `No ${tc} games found`, current: i + 1, total: perTc.length, count: 0 });
          }
        }
        games.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      } else {
        send('progress', { step: 'profile', message: 'Fetching player profile...' });
        const [gamesResult, profileResult] = await Promise.all([
          fetchPlayerGames(uTrimmed, pLower, 1000, 'all'),
          fetchPlayerProfile(uTrimmed, pLower)
        ]);
        games = gamesResult;
        profile = profileResult;
        send('progress', { step: 'games', message: `${games.length} games loaded`, current: 1, total: 1, count: games.length });
      }

      if (!games.length) {
        send('error', { error: 'No recent games found for this player.' });
        if (!res.writableEnded) res.end();
        return;
      }

      const perfs = profile ? profile.perfs : {};
      log('info', 'Scout games total', { count: games.length, tcBreakdown: games.reduce((acc, g) => { acc[g.timeControl] = (acc[g.timeControl] || 0) + 1; return acc; }, {}) });

      // Send games in batches to avoid huge SSE payloads
      const BATCH = 100;
      for (let i = 0; i < games.length; i += BATCH) {
        send('games', { batch: games.slice(i, i + BATCH) });
      }

      send('done', { perfs });
    } catch (err) {
      log('warn', 'Scout failed', { error: err.message });
      send('error', { error: err.message || 'Scout failed.' });
    }

    if (!res.writableEnded) res.end();
  });
}

async function handleScoutReport(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      const { stats, username, timeControl } = JSON.parse(body);
      if (!stats || !username) {
        return sendJson(res, 400, { error: 'Stats and username required.' });
      }
      const report = await generateScoutReport(stats, username, timeControl || 'all');
      sendJson(res, 200, { report });
    } catch (err) {
      log('warn', 'Scout report failed', { error: err.message });
      sendJson(res, 500, { error: err.message || 'Report generation failed.' });
    }
  });
}

async function handleGenerateRepertoire(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      const { opening, color, pgn } = JSON.parse(body);
      if (!opening || !color || !pgn) {
        return sendJson(res, 400, { error: 'Opening name, color, and pgn required.' });
      }

      log('info', 'Repertoire request', { opening, color });

      // 1. Parse the base opening moves
      const Chess = getChess();
      const baseMoves = [];
      const chess = new Chess();
      const tokens = pgn.replace(/\d+\./g, '').trim().split(/\s+/);
      for (const t of tokens) {
        const m = chess.move(t, { sloppy: true });
        if (!m) break;
        baseMoves.push(m.san);
      }
      const baseFen = chess.fen();

      // 2. Explore continuations from the Lichess masters database
      const lines = [];
      // Main line: follow the most popular move at each step for 6 more moves
      lines.push(await exploreLine(baseMoves, baseFen, 6, 0));

      // Alternative lines: pick the 2nd and 3rd most popular responses at the first branch
      const firstExplore = await fetchExplorerMoves(baseFen);
      for (let i = 1; i < Math.min(3, firstExplore.length); i++) {
        const altMove = firstExplore[i];
        const altChess = new Chess(baseFen);
        const altResult = altChess.move(altMove.san, { sloppy: true });
        if (!altResult) continue;
        const altMoves = [...baseMoves, altResult.san];
        const altLine = await exploreLine(altMoves, altChess.fen(), 5, i);
        lines.push(altLine);
      }

      if (!lines.length || !lines[0].moves.length) {
        return sendJson(res, 500, { error: 'Could not find opening lines. Try a different opening.' });
      }

      // 3. Ask Gemini to explain the key moves (student's color only)
      const studentMoveIndices = [];
      const allMovesSample = lines[0].moves;
      for (let i = 0; i < allMovesSample.length; i++) {
        const isWhiteMove = i % 2 === 0;
        if ((color === 'white' && isWhiteMove) || (color === 'black' && !isWhiteMove)) {
          studentMoveIndices.push(i);
        }
      }

      const linesForPrompt = lines.map(l => l.name + ': ' + l.moves.join(' ')).join('\n');
      const prompt = `You are a chess opening coach. The student is learning the "${opening}" as ${color}.

Here are the main lines from master games:
${linesForPrompt}

For each line, provide a brief explanation (1-2 sentences) for each of the ${color} moves — what the move controls, threatens, or prepares. Focus on practical ideas, not just naming the move.

Return JSON:
{
  "description": "2-3 sentence overview of this opening's key ideas",
  "lines": [
    {
      "name": "line name",
      "explanations": { "1": "explanation for move 1", "3": "explanation for move 3" }
    }
  ]
}

The explanation keys are 1-indexed move numbers (position in the move list, not full-move numbers). For white: explain moves at positions 1, 3, 5... For black: explain moves at positions 2, 4, 6...
Return ONLY valid JSON.`;

      const geminiBody = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json'
        }
      };

      const result = await callGemini(GEMINI_PRIMARY_MODEL, geminiBody, { feature: 'repertoire', opening });

      let description = '';
      if (result.ok) {
        const parsed = safeParseJson(result.text);
        if (parsed) {
          description = parsed.description || '';
          if (parsed.lines) {
            for (let i = 0; i < lines.length && i < parsed.lines.length; i++) {
              lines[i].explanations = parsed.lines[i].explanations || {};
            }
          }
        }
      }

      sendJson(res, 200, {
        repertoire: {
          name: opening,
          color,
          description,
          lines
        }
      });
    } catch (err) {
      log('warn', 'Repertoire generation failed', { error: err.message });
      sendJson(res, 500, { error: err.message || 'Repertoire generation failed.' });
    }
  });
}

async function handleExplainOpening(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      const { opening, color, lines } = JSON.parse(body);
      if (!opening || !color || !lines || !lines.length) {
        return sendJson(res, 400, { error: 'opening, color, and lines required.' });
      }

      log('info', 'Explain opening request', { opening, color, lineCount: lines.length });

      const linesForPrompt = lines.map(l => l.name + ': ' + l.moves.join(' ')).join('\n');
      const prompt = `You are a chess opening coach. The student is learning the "${opening}" as ${color}.

Here are the lines to explain:
${linesForPrompt}

For EVERY move in each line (both white and black moves), provide a brief explanation (1-2 sentences) of what the move does — what it controls, threatens, defends, or prepares. Be practical and specific to the position, not generic.

Return JSON:
{
  "description": "2-3 sentence overview of this opening's key ideas and plans",
  "lines": [
    {
      "name": "line name",
      "explanations": { "1": "explanation for move at position 1", "2": "explanation for move at position 2", "3": "..." }
    }
  ]
}

The explanation keys are 1-indexed positions in the move list (1 = first move, 2 = second move, etc).
Explain ALL moves, not just the student's color.
Return ONLY valid JSON.`;

      const geminiBody = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json'
        }
      };

      const result = await callGemini(GEMINI_PRIMARY_MODEL, geminiBody, { feature: 'explain-opening', opening });

      if (!result.ok) {
        return sendJson(res, 500, { error: result.error || 'Gemini request failed.' });
      }

      const parsed = safeParseJson(result.text);
      if (!parsed) {
        return sendJson(res, 500, { error: 'Failed to parse AI response.' });
      }

      sendJson(res, 200, {
        description: parsed.description || '',
        lines: parsed.lines || []
      });
    } catch (err) {
      log('warn', 'Explain opening failed', { error: err.message });
      sendJson(res, 500, { error: err.message || 'Failed to explain opening.' });
    }
  });
}

async function handleAskOpening(req, res) {
  let body = '';
  req.on('data', (chunk) => { body += chunk.toString(); });
  req.on('end', async () => {
    try {
      const { opening, color, moves, fen, question } = JSON.parse(body);
      if (!question) {
        return sendJson(res, 400, { error: 'question is required.' });
      }

      log('info', 'Ask opening question', { opening, question: question.slice(0, 80) });

      const movesStr = (moves || []).join(' ');
      const prompt = `You are a friendly, expert chess opening coach. The student is learning the "${opening || 'opening'}" as ${color || 'white'}.

Current position after moves: ${movesStr || '(starting position)'}
FEN: ${fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'}

The student asks: "${question}"

Give a clear, practical answer in 2-4 sentences. Focus on concrete ideas — what squares to control, what pieces to develop, what plans to follow. Speak like a coach sitting next to them, not a textbook.`;

      const geminiBody = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 512
        }
      };

      const result = await callGemini(GEMINI_PRIMARY_MODEL, geminiBody, { feature: 'ask-opening', opening });

      if (!result.ok) {
        return sendJson(res, 500, { error: result.error || 'Failed to get answer.' });
      }

      sendJson(res, 200, { answer: result.text.trim() });
    } catch (err) {
      log('warn', 'Ask opening failed', { error: err.message });
      sendJson(res, 500, { error: err.message || 'Failed to answer question.' });
    }
  });
}

async function fetchExplorerMoves(fen) {
  try {
    const url = `https://explorer.lichess.ovh/masters?fen=${encodeURIComponent(fen)}&topGames=0&recentGames=0`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.moves || []).slice(0, 5);
  } catch (e) {
    log('warn', 'Explorer fetch failed', { error: e.message });
    return [];
  }
}

async function exploreLine(baseMoves, fen, depth, lineIndex) {
  const Chess = getChess();
  const chess = new Chess(fen);
  const moves = [...baseMoves];
  const lineNames = ['Main Line', 'Alternative Line', 'Sideline'];

  for (let d = 0; d < depth; d++) {
    const explorerMoves = await fetchExplorerMoves(chess.fen());
    if (!explorerMoves.length) break;
    const best = explorerMoves[0];
    const result = chess.move(best.san, { sloppy: true });
    if (!result) break;
    moves.push(result.san);
  }

  return {
    name: lineNames[lineIndex] || `Variation ${lineIndex + 1}`,
    moves,
    explanations: {}
  };
}

async function fetchPlayerProfile(username, platform) {
  try {
    if (platform === 'lichess') {
      const resp = await fetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const perfs = {};
      for (const [key, val] of Object.entries(data.perfs || {})) {
        perfs[key] = val.rating;
      }
      return { perfs };
    } else if (platform === 'chesscom') {
      const resp = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/stats`, {
        headers: { 'User-Agent': 'Chessimus/1.0' }
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      const perfs = {};
      if (data.chess_bullet?.last?.rating) perfs.bullet = data.chess_bullet.last.rating;
      if (data.chess_blitz?.last?.rating) perfs.blitz = data.chess_blitz.last.rating;
      if (data.chess_rapid?.last?.rating) perfs.rapid = data.chess_rapid.last.rating;
      return { perfs };
    }
  } catch (e) {
    log('warn', 'Profile fetch failed', { error: e.message });
  }
  return null;
}

async function fetchPlayerGames(username, platform, limit, timeControl) {
  const games = [];

  if (platform === 'lichess') {
    // Lichess perfType values: bullet, blitz, rapid, classical, ultraBullet
    const perfParam = (timeControl && timeControl !== 'all') ? `&perfType=${timeControl}` : '';
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?max=${limit}&opening=true&pgnInJson=true${perfParam}`;
    log('info', 'Fetching Lichess games', { username, url });
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/x-ndjson' }
    });
    if (!resp.ok) throw new Error(`Lichess returned ${resp.status}. Check the username.`);

    const text = await resp.text();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const g = JSON.parse(line);
        const parsed = parseLichessGame(g, username);
        log('debug', 'Lichess game parsed', {
          id: g.id,
          speed: g.speed,
          perf: g.perf,
          parsedTC: parsed.timeControl,
          color: parsed.color,
          result: parsed.result,
          opening: parsed.opening,
          rating: parsed.playerRating
        });
        games.push(parsed);
      } catch (e) { /* skip bad line */ }
    }
  } else if (platform === 'chesscom') {
    log('info', 'Fetching Chess.com games', { username });
    // Get archives list
    const archResp = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/archives`, {
      headers: { 'User-Agent': 'Chessimus/1.0' }
    });
    if (!archResp.ok) throw new Error(`Chess.com returned ${archResp.status}. Check the username.`);

    const archData = await archResp.json();
    const archives = archData.archives || [];
    if (!archives.length) throw new Error('No game archives found.');

    // Fetch last 2 months to get enough games
    // Fetch enough months based on limit
    const monthsToFetch = limit <= 50 ? 2 : limit <= 300 ? 6 : 18;
    const recentArchives = archives.slice(-monthsToFetch);
    for (const archUrl of recentArchives) {
      const resp = await fetch(archUrl, { headers: { 'User-Agent': 'Chessimus/1.0' } });
      if (!resp.ok) continue;
      const data = await resp.json();
      for (const g of (data.games || [])) {
        games.push(parseChesscomGame(g, username));
      }
    }
    // Take most recent N
    games.splice(0, Math.max(0, games.length - limit));
  } else {
    throw new Error('Platform must be "lichess" or "chesscom".');
  }

  log('info', 'Games fetched', { count: games.length });

  // Log time control breakdown
  const tcBreakdown = {};
  for (const g of games) {
    tcBreakdown[g.timeControl] = (tcBreakdown[g.timeControl] || 0) + 1;
  }
  log('info', 'Time control breakdown', tcBreakdown);

  return games;
}

function parseLichessGame(g, username) {
  const uLower = username.toLowerCase();
  const isWhite = (g.players?.white?.user?.id || '').toLowerCase() === uLower;
  const color = isWhite ? 'white' : 'black';
  const opponent = isWhite ? g.players?.black : g.players?.white;
  const winner = g.winner; // 'white', 'black', or undefined (draw)

  let result = 'draw';
  if (winner === color) result = 'win';
  else if (winner && winner !== color) result = 'loss';

  return {
    color,
    result,
    opening: g.opening?.name || '',
    eco: g.opening?.eco || '',
    termination: g.status || '', // mate, resign, outoftime, draw, stalemate
    timeControl: g.speed || categorizeTimeControl(g.clock?.initial, g.clock?.increment),
    playerRating: isWhite ? g.players?.white?.rating : g.players?.black?.rating,
    opponentRating: opponent?.rating || null,
    opponentName: opponent?.user?.name || opponent?.user?.id || 'Anonymous',
    moves: g.moves ? g.moves.split(' ').length : 0,
    date: g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : ''
  };
}

function parseChesscomGame(g, username) {
  const uLower = username.toLowerCase();
  const isWhite = (g.white?.username || '').toLowerCase() === uLower;
  const color = isWhite ? 'white' : 'black';
  const playerData = isWhite ? g.white : g.black;
  const opponentData = isWhite ? g.black : g.white;

  let result = 'draw';
  if (playerData?.result === 'win') result = 'win';
  else if (opponentData?.result === 'win') result = 'loss';

  // Extract opening from PGN headers
  let opening = '';
  let eco = '';
  if (g.pgn) {
    opening = extractPgnHeader(g.pgn, 'Opening') || extractPgnHeader(g.pgn, 'ECOUrl') || '';
    eco = extractPgnHeader(g.pgn, 'ECO') || '';
    // Clean up Chess.com ECOUrl format
    if (opening.includes('/')) opening = opening.split('/').pop().replace(/-/g, ' ');
  }

  // Termination
  const pResult = playerData?.result || '';
  const oResult = opponentData?.result || '';
  let termination = '';
  if (pResult === 'checkmated' || oResult === 'checkmated') termination = 'mate';
  else if (pResult === 'timeout' || oResult === 'timeout') termination = 'outoftime';
  else if (pResult === 'resigned' || oResult === 'resigned') termination = 'resign';
  else if (pResult === 'abandoned' || oResult === 'abandoned') termination = 'abandoned';
  else termination = 'draw';

  return {
    color,
    result,
    opening: opening || '',
    eco,
    termination,
    timeControl: g.time_class || '',
    playerRating: playerData?.rating || null,
    opponentRating: opponentData?.rating || null,
    opponentName: opponentData?.username || 'Anonymous',
    moves: g.pgn ? (g.pgn.match(/\d+\./g) || []).length : 0,
    date: g.end_time ? new Date(g.end_time * 1000).toISOString().slice(0, 10) : ''
  };
}

function extractPgnHeader(pgn, key) {
  const re = new RegExp('\\[' + key + '\\s+"([^"]*)"\\]');
  const m = pgn.match(re);
  return m ? m[1] : '';
}

function categorizeTimeControl(initialSec, incrementSec) {
  if (!initialSec) return 'unknown';
  const total = initialSec + (incrementSec || 0) * 40;
  if (total < 180) return 'bullet';
  if (total < 600) return 'blitz';
  if (total < 1800) return 'rapid';
  return 'classical';
}

function aggregateStats(games, username) {
  const stats = {
    username,
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
    ratings: [],
    avgMoveCount: 0
  };

  let totalMoves = 0;

  for (const g of games) {
    // Overall
    if (g.result === 'win') stats.overall.wins++;
    else if (g.result === 'loss') stats.overall.losses++;
    else stats.overall.draws++;

    // By color
    const cs = stats.byColor[g.color];
    if (cs) {
      cs.total++;
      if (g.result === 'win') cs.wins++;
      else if (g.result === 'loss') cs.losses++;
      else cs.draws++;
    }

    // Openings
    const opName = g.opening || g.eco || 'Unknown';
    if (!stats.openings[opName]) stats.openings[opName] = { wins: 0, losses: 0, draws: 0, total: 0 };
    stats.openings[opName].total++;
    if (g.result === 'win') stats.openings[opName].wins++;
    else if (g.result === 'loss') stats.openings[opName].losses++;
    else stats.openings[opName].draws++;

    // How they lose/win
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

    // Time control
    const tc = g.timeControl || 'unknown';
    if (!stats.byTimeControl[tc]) stats.byTimeControl[tc] = { wins: 0, losses: 0, draws: 0, total: 0 };
    stats.byTimeControl[tc].total++;
    if (g.result === 'win') stats.byTimeControl[tc].wins++;
    else if (g.result === 'loss') stats.byTimeControl[tc].losses++;
    else stats.byTimeControl[tc].draws++;

    // Ratings
    if (g.playerRating) stats.ratings.push(g.playerRating);

    totalMoves += g.moves || 0;
  }

  stats.avgMoveCount = games.length ? Math.round(totalMoves / games.length) : 0;

  return stats;
}

async function generateScoutReport(stats, username, timeControl) {
  const fallback = {
    overview: `Analysis of ${stats.totalGames} recent games for ${username}.`,
    weakestOpenings: 'Not enough data to determine.',
    strongestOpenings: 'Not enough data to determine.',
    colorWeakness: 'No significant difference detected.',
    tendencies: 'Play more games for pattern detection.',
    howToBeat: 'No clear weaknesses identified yet.',
    selfImprovement: 'Keep playing and analyzing your games.'
  };

  if (!GEMINI_API_KEY) return fallback;

  // Build opening summary (only openings played 2+ times)
  const openingSummary = Object.entries(stats.openings)
    .filter(([, v]) => v.total >= 2)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 15)
    .map(([name, v]) => {
      const wr = v.total ? Math.round((v.wins / v.total) * 100) : 0;
      return `${name}: ${v.wins}W/${v.losses}L/${v.draws}D (${wr}% win rate, ${v.total} games)`;
    })
    .join('\n');

  const whiteWR = stats.byColor.white.total ? Math.round((stats.byColor.white.wins / stats.byColor.white.total) * 100) : 0;
  const blackWR = stats.byColor.black.total ? Math.round((stats.byColor.black.wins / stats.byColor.black.total) * 100) : 0;
  const overallWR = stats.totalGames ? Math.round((stats.overall.wins / stats.totalGames) * 100) : 0;

  const ratingTrend = stats.ratings.length >= 2
    ? `Started at ${stats.ratings[stats.ratings.length - 1]}, currently ${stats.ratings[0]}`
    : 'Not enough data';

  const tcLabel = timeControl === 'all' ? 'all time controls' : timeControl;
  const prompt = [
    `You are a chess scout analyzing player "${username}" based on their last ${stats.totalGames} ${tcLabel} games.`,
    '',
    `OVERALL: ${stats.overall.wins}W / ${stats.overall.losses}L / ${stats.overall.draws}D (${overallWR}% win rate)`,
    `AS WHITE: ${stats.byColor.white.wins}W/${stats.byColor.white.losses}L/${stats.byColor.white.draws}D (${whiteWR}%) — ${stats.byColor.white.total} games`,
    `AS BLACK: ${stats.byColor.black.wins}W/${stats.byColor.black.losses}L/${stats.byColor.black.draws}D (${blackWR}%) — ${stats.byColor.black.total} games`,
    '',
    `HOW THEY LOSE: Checkmate ${stats.howTheyLose.mate}, Resignation ${stats.howTheyLose.resign}, Timeout ${stats.howTheyLose.timeout}, Other ${stats.howTheyLose.other}`,
    `HOW THEY WIN: Checkmate ${stats.howTheyWin.mate}, Resignation ${stats.howTheyWin.resign}, Timeout ${stats.howTheyWin.timeout}, Other ${stats.howTheyWin.other}`,
    `AVG GAME LENGTH: ${stats.avgMoveCount} moves`,
    `RATING TREND: ${ratingTrend}`,
    '',
    'OPENINGS (played 2+ times):',
    openingSummary || 'Not enough repeated openings.',
    '',
    'Produce a scouting report with these sections. Be specific, reference the actual data. Write like a coach briefing a player before a match.'
  ].join('\n');

  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          overview: { type: 'STRING' },
          weakestOpenings: { type: 'STRING' },
          strongestOpenings: { type: 'STRING' },
          colorWeakness: { type: 'STRING' },
          tendencies: { type: 'STRING' },
          howToBeat: { type: 'STRING' },
          selfImprovement: { type: 'STRING' }
        },
        required: ['overview', 'weakestOpenings', 'strongestOpenings', 'colorWeakness', 'tendencies', 'howToBeat', 'selfImprovement']
      }
    }
  };

  const result = await callGemini(GEMINI_PRIMARY_MODEL, body, { feature: 'scout', username });
  if (!result.ok) {
    log('warn', 'Scout Gemini call failed', { error: result.error });
    return fallback;
  }

  const parsed = parseGeminiJson(result.text);
  if (!parsed || !parsed.overview) {
    log('warn', 'Scout Gemini parse failed', { snippet: (result.text || '').slice(0, 200) });
    return fallback;
  }

  return {
    overview: parsed.overview || fallback.overview,
    weakestOpenings: parsed.weakestOpenings || fallback.weakestOpenings,
    strongestOpenings: parsed.strongestOpenings || fallback.strongestOpenings,
    colorWeakness: parsed.colorWeakness || fallback.colorWeakness,
    tendencies: parsed.tendencies || fallback.tendencies,
    howToBeat: parsed.howToBeat || fallback.howToBeat,
    selfImprovement: parsed.selfImprovement || fallback.selfImprovement
  };
}

function createServer() {
  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'POST' && requestUrl.pathname === '/analyze') {
      handleAnalyze(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/analyze-stream') {
      handleAnalyzeStream(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/import') {
      handleImport(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/scout') {
      handleScout(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/scout-report') {
      handleScoutReport(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/generate-repertoire') {
      handleGenerateRepertoire(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/explain-opening') {
      handleExplainOpening(req, res);
      return;
    }

    if (req.method === 'POST' && requestUrl.pathname === '/ask-opening') {
      handleAskOpening(req, res);
      return;
    }

    if (req.method === 'GET') {
      if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
        sendStatic(res, path.join(PUBLIC_DIR, 'index.html'));
        return;
      }

      const safePath = requestUrl.pathname.replace(/\.\./g, '');
      const candidate = path.join(PUBLIC_DIR, safePath);
      if (candidate.startsWith(PUBLIC_DIR)) {
        sendStatic(res, candidate);
        return;
      }
    }

    sendText(res, 404, 'Not found');
  });
}

if (require.main === module) {
  log('info', 'Booting server', { port: PORT });
  const server = createServer();
  server.on('error', (err) => {
    log('error', 'Failed to start server', { error: err.message });
    process.exit(1);
  });
  server.listen(PORT, () => {
    log('info', 'Server listening', { url: `http://localhost:${PORT}` });
  });

  process.on('uncaughtException', (err) => {
    log('error', 'Uncaught exception', { error: err.message });
  });

  process.on('unhandledRejection', (reason) => {
    log('error', 'Unhandled rejection', { error: String(reason) });
  });
}

async function analyzeGame(pgn, onProgress) {
  const emit = onProgress || (() => {});
  const Chess = getChess();
  const chess = loadGameFromPgn(pgn);
  const moves = chess.history({ verbose: true });
  const trimmedMoves = moves.slice(0, MAX_MOVES);
  log('info', 'Analysis start', { totalMoves: moves.length, maxMoves: MAX_MOVES });

  emit('phase', { phase: 'stockfish', total: trimmedMoves.length + 1 });

  // Phase 1: Stockfish — evaluate each position ONCE and cache results
  const engine = new StockfishEngine(STOCKFISH_PATH);
  await engine.init();

  const game = new Chess();
  const evals = [];

  evals.push(await engine.analyze(game.fen(), STOCKFISH_DEPTH));
  emit('stockfish', { current: 1, total: trimmedMoves.length + 1 });

  for (let i = 0; i < trimmedMoves.length; i += 1) {
    const moveApplied = game.move(trimmedMoves[i]);
    if (!moveApplied) break;
    evals.push(await engine.analyze(game.fen(), STOCKFISH_DEPTH));
    emit('stockfish', { current: i + 2, total: trimmedMoves.length + 1 });
  }

  await engine.quit();
  log('info', 'Stockfish done', { positions: evals.length });

  // Phase 2: Build move data and emit each move as it's ready
  const result = [];
  const coachQueue = [];

  const replay = new Chess();
  for (let i = 0; i < trimmedMoves.length; i += 1) {
    const move = trimmedMoves[i];
    const mover = replay.turn();
    const beforeFen = replay.fen();

    const before = evals[i];
    const moveApplied = replay.move(move);
    if (!moveApplied) break;
    const after = evals[i + 1];

    const beforeEval = scoreToWhite(before, mover);
    const afterEval = scoreToWhite(after, replay.turn());

    const moverBefore = mover === 'w' ? beforeEval.cpApprox : -beforeEval.cpApprox;
    const moverAfter = mover === 'w' ? afterEval.cpApprox : -afterEval.cpApprox;
    const delta = moverAfter - moverBefore;

    const label = labelFromDelta(delta);
    const bestMoveSan = uciToSan(beforeFen, before.bestMove);
    const pvSan = pvToSan(beforeFen, before.pv);

    const entry = {
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      mover: mover === 'w' ? 'White' : 'Black',
      san: move.san,
      uci: move.from + move.to + (move.promotion || ''),
      evalBefore: formatEval(beforeEval),
      evalAfter: formatEval(afterEval),
      deltaCp: Math.round(delta),
      label,
      bestMove: bestMoveSan,
      pv: pvSan,
      explanation: null
    };

    // Emit each move with its eval data immediately
    emit('move', entry);

    if (shouldExplain(label)) {
      coachQueue.push({
        index: result.length,
        facts: {
          move: move.san,
          sideToMove: entry.mover,
          fen: beforeFen,
          evalBefore: entry.evalBefore,
          evalAfter: entry.evalAfter,
          deltaCp: entry.deltaCp,
          label,
          bestMove: bestMoveSan || before.bestMove || 'unknown',
          pvLine: pvSan.join(' ')
        }
      });
    }

    result.push(entry);
  }

  // Phase 3: Gemini coaching — run in parallel batches, emit each as done
  log('info', 'Coaching start', { movesToExplain: coachQueue.length });
  emit('phase', { phase: 'coaching', total: coachQueue.length });

  const BATCH_SIZE = 10;
  let coachDone = 0;
  for (let b = 0; b < coachQueue.length; b += BATCH_SIZE) {
    const batch = coachQueue.slice(b, b + BATCH_SIZE);
    const explanations = await Promise.all(
      batch.map((item) => generateExplanation(item.facts))
    );
    for (let j = 0; j < batch.length; j++) {
      result[batch[j].index].explanation = explanations[j];
      coachDone++;
      emit('coach', {
        ply: result[batch[j].index].ply,
        explanation: explanations[j],
        current: coachDone,
        total: coachQueue.length
      });
    }
  }

  emit('done', { totalMoves: result.length, explained: coachQueue.length });
  log('info', 'Analysis complete', { analyzedMoves: result.length, explained: coachQueue.length });
  return result;
}

function loadGameFromPgn(pgnText) {
  const Chess = getChess();
  const chess = new Chess();
  let loaded = false;
  try {
    const result = chess.loadPgn(pgnText, { sloppy: true });
    if (result !== false && chess.history().length > 0) {
      loaded = true;
    }
  } catch (err) {
    loaded = false;
  }

  if (loaded) return chess;

  chess.reset();
  const tokens = tokenizePgn(pgnText);
  let ply = 0;
  for (const token of tokens) {
    const cleaned = stripAnnotations(token);
    if (!cleaned || isResultToken(cleaned)) {
      continue;
    }
    const move = chess.move(cleaned, { sloppy: true });
    if (!move) {
      const moveNumber = Math.floor(ply / 2) + 1;
      const side = ply % 2 === 0 ? 'White' : 'Black';
      throw new Error(`Invalid move "${token}" at move ${moveNumber} (${side}).`);
    }
    ply += 1;
  }

  if (ply === 0) {
    throw new Error('Invalid PGN: no moves found.');
  }

  return chess;
}

function tokenizePgn(pgnText) {
  const lines = pgnText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('['));

  const withoutHeaders = lines.join(' ');
  const stripped = withoutHeaders
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/;[^\n]*/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\d+\.\.\./g, ' ')
    .replace(/\d+\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) return [];
  return stripped.split(' ');
}

function stripAnnotations(token) {
  return token.replace(/[!?]+$/g, '');
}

function isResultToken(token) {
  return token === '1-0' || token === '0-1' || token === '1/2-1/2' || token === '*';
}

function labelFromDelta(delta) {
  if (delta >= 30) return 'good';
  if (delta <= -300) return 'blunder';
  if (delta <= -150) return 'mistake';
  if (delta <= -50) return 'inaccuracy';
  return 'ok';
}

function shouldExplain(label) {
  return label === 'inaccuracy' || label === 'mistake' || label === 'blunder';
}

function scoreToWhite(score, sideToMove) {
  if (score.mate !== null && typeof score.mate === 'number') {
    const mateWhite = sideToMove === 'w' ? score.mate : -score.mate;
    const cpApprox = mateWhite > 0 ? 10000 : -10000;
    return { cp: null, mate: mateWhite, cpApprox };
  }

  const cp = typeof score.cp === 'number' ? score.cp : 0;
  const cpWhite = sideToMove === 'w' ? cp : -cp;
  return { cp: cpWhite, mate: null, cpApprox: cpWhite };
}

function formatEval(evalObj) {
  if (evalObj.mate !== null) {
    return `M${evalObj.mate}`;
  }
  return (evalObj.cp / 100).toFixed(2);
}

function uciToSan(fen, uci) {
  const Chess = getChess();
  if (!uci) return '';
  const chess = new Chess(fen);
  const move = chess.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : undefined
  });
  return move ? move.san : '';
}

function pvToSan(fen, pv) {
  const Chess = getChess();
  if (!pv) return [];
  const chess = new Chess(fen);
  const moves = pv.trim().split(/\s+/);
  const san = [];
  for (const uci of moves.slice(0, 6)) {
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined
    });
    if (!move) break;
    san.push(move.san);
  }
  return san;
}

class StockfishEngine {
  constructor(binaryPath) {
    this.binaryPath = binaryPath;
    this.process = null;
    this.rl = null;
    this.waiters = [];
    this.currentAnalysis = null;
    this.queue = Promise.resolve();
  }

  async init() {
    log('info', 'Spawning Stockfish', { path: this.binaryPath });
    this.process = spawn(this.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });

    this.process.on('error', (err) => {
      log('error', 'Stockfish spawn error', { error: err.message, path: this.binaryPath });
    });

    this.process.stderr.on('data', (data) => {
      log('warn', 'Stockfish stderr', { output: data.toString().trim() });
    });

    this.process.on('exit', (code, signal) => {
      log('info', 'Stockfish exited', { code, signal });
    });

    this.rl = readline.createInterface({ input: this.process.stdout });
    this.rl.on('line', (line) => this._onLine(line));

    this.send('uci');
    await this.waitFor((line) => line === 'uciok', 5000);

    this.send('setoption name UCI_AnalyseMode value true');
    this.send('setoption name MultiPV value 1');
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 128');

    this.send('isready');
    await this.waitFor((line) => line === 'readyok', 5000);
  }

  async quit() {
    if (!this.process) return;
    this.send('quit');
    this.rl.close();
    this.process.kill();
  }

  analyze(fen, depth) {
    this.queue = this.queue.then(() => this._analyze(fen, depth));
    return this.queue;
  }

  _analyze(fen, depth) {
    return new Promise((resolve, reject) => {
      const best = {
        depth: -1,
        cp: null,
        mate: null,
        pv: '',
        bestMove: ''
      };

      const timeout = setTimeout(() => {
        this.currentAnalysis = null;
        reject(new Error('Stockfish analysis timed out.'));
      }, 15000);

      this.currentAnalysis = (line) => {
        if (line.startsWith('info')) {
          const depthMatch = line.match(/\bdepth (\d+)\b/);
          const depthValue = depthMatch ? parseInt(depthMatch[1], 10) : null;
          if (depthValue !== null && depthValue >= best.depth) {
            const cpMatch = line.match(/\bscore cp (-?\d+)\b/);
            const mateMatch = line.match(/\bscore mate (-?\d+)\b/);
            const pvMatch = line.match(/\bpv (.+)$/);
            best.depth = depthValue;
            best.cp = cpMatch ? parseInt(cpMatch[1], 10) : best.cp;
            best.mate = mateMatch ? parseInt(mateMatch[1], 10) : best.mate;
            best.pv = pvMatch ? pvMatch[1] : best.pv;
          }
        }

        if (line.startsWith('bestmove')) {
          clearTimeout(timeout);
          const tokens = line.split(/\s+/);
          best.bestMove = tokens[1] || '';
          this.currentAnalysis = null;
          resolve({ cp: best.cp, mate: best.mate, pv: best.pv, bestMove: best.bestMove });
        }
      };

      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  send(command) {
    if (this.process && this.process.stdin.writable) {
      this.process.stdin.write(`${command}\n`);
    }
  }

  waitFor(predicate, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error('Stockfish did not respond in time.'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  _onLine(line) {
    if (this.currentAnalysis) {
      this.currentAnalysis(line);
      return;
    }

    for (const waiter of [...this.waiters]) {
      if (waiter.predicate(line)) {
        clearTimeout(waiter.timeout);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        waiter.resolve(line);
        break;
      }
    }
  }
}

async function generateExplanation(facts) {
  if (!GEMINI_API_KEY) {
    return {
      summary: 'LLM not configured. Set GEMINI_API_KEY to enable coach explanations.',
      whyBad: 'Stockfish evaluation dropped for the player.',
      betterMove: facts.bestMove,
      tip: 'Compare your move to Stockfish\'s top line and look for tactical threats.',
      factsUsed: ['evalBefore', 'evalAfter', 'deltaCp', 'bestMove', 'pvLine']
    };
  }

  if (!loggedGeminiConfig) {
    loggedGeminiConfig = true;
    log('info', 'Gemini config', {
      model: GEMINI_PRIMARY_MODEL
    });
  }

  return await generateCoachExplanation(facts);
}

function safeParseJson(text) {
  if (!text) return null;
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '');
  cleaned = cleaned.replace(/^```/, '');
  cleaned = cleaned.replace(/```$/, '');

  const start = cleaned.indexOf('{');
  if (start === -1) return null;

  let fragment = cleaned.slice(start);

  // Try parsing as-is first
  try {
    return JSON.parse(fragment);
  } catch (err) {
    // ignore
  }

  // Try to repair truncated JSON by closing open strings and braces
  // Remove trailing incomplete key-value pair after last complete value
  let repaired = fragment;

  // If we're mid-string, close it
  const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    repaired += '"';
  }

  // Close any open arrays
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/\]/g) || []).length;
  for (let i = 0; i < openBrackets - closeBrackets; i++) {
    repaired += ']';
  }

  // Close any open objects
  const openBraces = (repaired.match(/\{/g) || []).length;
  const closeBraces = (repaired.match(/\}/g) || []).length;
  for (let i = 0; i < openBraces - closeBraces; i++) {
    repaired += '}';
  }

  try {
    return JSON.parse(repaired);
  } catch (err) {
    // Last resort: find the last complete key-value and close there
    const lastCompleteComma = repaired.lastIndexOf('",');
    if (lastCompleteComma > 0) {
      const truncated = repaired.slice(0, lastCompleteComma + 1);
      // Close arrays and objects
      let attempt = truncated;
      const ob = (attempt.match(/\[/g) || []).length - (attempt.match(/\]/g) || []).length;
      for (let i = 0; i < ob; i++) attempt += ']';
      const oc = (attempt.match(/\{/g) || []).length - (attempt.match(/\}/g) || []).length;
      for (let i = 0; i < oc; i++) attempt += '}';
      try {
        return JSON.parse(attempt);
      } catch (e) {
        return null;
      }
    }
    return null;
  }
}

function parseGeminiJson(text) {
  if (!text) return null;
  const cleaned = cleanGeminiText(text);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    return safeParseJson(cleaned);
  }
}

function cleanGeminiText(text) {
  if (!text) return '';
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^Here is the JSON requested:\s*/i, '');
  cleaned = cleaned.replace(/^```json\s*/i, '');
  cleaned = cleaned.replace(/^```/, '');
  cleaned = cleaned.replace(/```$/, '');
  return cleaned.trim();
}

function normalizeModel(model) {
  if (!model) return '';
  return model.startsWith('models/') ? model : `models/${model}`;
}


async function callGemini(model, body, meta) {
  const modelPath = normalizeModel(model);
  if (!modelPath) {
    return { ok: false, error: 'Model not configured' };
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${GEMINI_API_KEY}`;
  log('info', 'Gemini request', { model: modelPath, ...meta });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    const msg = `Network error: ${err.message || 'unknown error'}`;
    if (lastGeminiError !== msg) {
      lastGeminiError = msg;
      log('error', 'Gemini request failed', { error: msg });
    }
    return { ok: false, error: msg };
  }

  if (!response.ok) {
    const detail = await readGeminiError(response);
    const msg = `HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
    if (lastGeminiError !== msg) {
      lastGeminiError = msg;
      log('error', 'Gemini response error', { error: msg });
    }
    return { ok: false, error: msg };
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const finishReason = data?.candidates?.[0]?.finishReason || '';
  if (finishReason && finishReason !== 'STOP') {
    log('warn', 'Gemini non-STOP finish', { finishReason, ...meta });
  }
  return { ok: true, text };
}

async function generateCoachExplanation(facts) {
  const fallback = {
    summary: `${facts.sideToMove}'s ${facts.move} was a ${facts.label}, losing about ${Math.abs(facts.deltaCp)} centipawns.`,
    whyBad: 'The engine evaluation dropped significantly after this move.',
    betterMove: `${facts.bestMove} was the engine's preferred move.`,
    tip: 'Look at the engine line and consider what threats it creates.',
    factsUsed: ['evalBefore', 'evalAfter', 'deltaCp', 'bestMove', 'pvLine']
  };

  const systemInstruction = [
    'You are an experienced, warm chess coach sitting next to a club player (1000-1600 Elo) reviewing their game.',
    '',
    'Your job is to help them genuinely UNDERSTAND what happened in the position — not just parrot engine numbers.',
    '',
    'For each move you explain, you must:',
    '1. SET THE SCENE: Describe what the position demands right now. What are the key features? (open files, weak squares, piece activity, pawn structure, king safety, development, space)',
    '2. EXPLAIN THE MISTAKE: Why was the played move wrong in human terms? What did it give up, allow, or miss? Be concrete — name squares, pieces, and ideas.',
    '3. EXPLAIN THE BETTER MOVE: What does the engine\'s preferred move actually DO? What idea or threat does it create? Why is it better strategically or tactically?',
    '4. GIVE A TAKEAWAY: One practical lesson they can remember for future games.',
    '',
    'IMPORTANT RULES:',
    '- Talk like a real coach, not a computer. Say things like "Your knight was beautifully placed on d5, but this move lets them kick it away" not "eval decreased by 87cp".',
    '- Reference specific squares, pieces, and ideas from the FEN position.',
    '- Name the chess theme when relevant: pin, fork, discovered attack, outpost, weak back rank, open file, pawn break, etc.',
    '- Do NOT just restate the eval numbers. The player can see those already.',
    '- Do NOT invent tactics or material changes not supported by the position.',
    '',
    'BREVITY IS CRITICAL — keep each field SHORT:',
    'Return ONLY valid JSON (no markdown, no code fences, no extra text) with exactly these keys:',
    '- "summary": 2-3 SHORT sentences max. Set the scene and explain the mistake. (~40 words)',
    '- "whyBad": 1 sentence. What the move gave up or allowed. (~20 words)',
    '- "betterMove": 1 sentence. What the better move does — the IDEA, not just notation. (~20 words)',
    '- "tip": 1 short sentence. A memorable takeaway. (~15 words)',
    '- "factsUsed": small array of fact keys you used'
  ].join('\n');

  const userPrompt = [
    `Position (FEN): ${facts.fen}`,
    `Move played: ${facts.sideToMove} played ${facts.move}`,
    `Classification: ${facts.label}`,
    `Eval before the move: ${facts.evalBefore}`,
    `Eval after the move: ${facts.evalAfter}`,
    `Centipawn loss: ${Math.abs(facts.deltaCp)}`,
    `Engine's best move: ${facts.bestMove}`,
    `Engine's main line: ${facts.pvLine || 'not available'}`,
    '',
    'Coach this move.'
  ].join('\n');

  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: GEMINI_TEMPERATURE,
      topP: 0.8,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          summary: { type: 'STRING' },
          whyBad: { type: 'STRING' },
          betterMove: { type: 'STRING' },
          tip: { type: 'STRING' },
          factsUsed: { type: 'ARRAY', items: { type: 'STRING' } }
        },
        required: ['summary', 'whyBad', 'betterMove', 'tip', 'factsUsed']
      }
    }
  };

  const result = await callGemini(GEMINI_PRIMARY_MODEL, body, { move: facts.move, label: facts.label });
  if (!result.ok) {
    log('warn', 'Gemini coach call failed', { move: facts.move, error: result.error });
    return fallback;
  }

  const parsed = parseGeminiJson(result.text);
  if (!parsed || !parsed.summary) {
    log('warn', 'Gemini coach parse failed', { move: facts.move, snippet: (result.text || '').slice(0, 200) });
    return fallback;
  }

  return {
    summary: parsed.summary || fallback.summary,
    whyBad: parsed.whyBad || '',
    betterMove: parsed.betterMove || facts.bestMove,
    tip: parsed.tip || '',
    factsUsed: Array.isArray(parsed.factsUsed) ? parsed.factsUsed : fallback.factsUsed
  };
}


async function readGeminiError(response) {
  try {
    const text = await response.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text);
      const message = parsed?.error?.message || parsed?.message || '';
      if (message) return message;
    } catch (err) {
      // fall through
    }
    return text.slice(0, 200).replace(/\s+/g, ' ');
  } catch (err) {
    return '';
  }
}

module.exports = {
  analyzeGame,
  StockfishEngine
};
