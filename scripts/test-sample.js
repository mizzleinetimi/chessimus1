process.env.STOCKFISH_DEPTH = process.env.STOCKFISH_DEPTH || '8';
process.env.MAX_MOVES = process.env.MAX_MOVES || '8';

const { analyzeGame } = require('../server');

const samplePgn = `[Event "Live Chess"]
[Site "Chess.com"]
[Date "2024.01.01"]
[White "WhitePlayer"]
[Black "BlackPlayer"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 1-0`;

(async () => {
  try {
    const analysis = await analyzeGame(samplePgn);
    console.log(`Analyzed ${analysis.length} moves.`);
    console.log(analysis.slice(0, 4));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
