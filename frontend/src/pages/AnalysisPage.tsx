import React, { useState, useEffect, useRef, useMemo } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { getRecentGames, getGameMoves, getGameEvals } from "../services/api.js";
import { Play, Square, Activity, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight, Upload, PanelLeftOpen, PanelLeftClose, RotateCcw, Repeat, MoveUpRight } from "lucide-react";
import { useBot } from "../context/BotContext.jsx";
import OpeningExplorer from "../components/OpeningExplorer";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EVAL_BAR_SPACE = 40; // eval bar width + gap, subtracted from the board's share

// Replays a line of SAN or UCI moves from the start position; null if any move is illegal.
function replayLine(line) {
    const g = new Chess();
    try {
        for (const m of line) g.move(m);
        return g;
    } catch (e) {
        return null;
    }
}

// Best line first; later lines fade so the top move stands out (chess.com style).
const SF_ARROW_COLORS = ["rgba(34,197,94,0.85)", "rgba(56,189,248,0.6)", "rgba(56,189,248,0.45)", "rgba(56,189,248,0.35)", "rgba(56,189,248,0.3)"];
const JB_ARROW_COLOR = "rgba(168,85,247,0.7)";
const PV_LENGTH = 16;

// Turns a raw "info depth ..." UCI line into line number, depth, white-relative score
// and the principal variation as chess.js moves (for SAN, arrows and replaying).
function parseEngineLine(line, fen) {
    const pvUci = line.match(/ pv (.+)$/)?.[1]?.trim().split(/\s+/);
    if (!pvUci) return null;

    const sign = fen.includes(" b ") ? -1 : 1;
    const cp = line.match(/score cp (-?\d+)/);
    const mate = line.match(/score mate (-?\d+)/);
    const whiteCp = cp ? parseInt(cp[1], 10) * sign : null;
    const whiteMate = mate ? parseInt(mate[1], 10) * sign : null;

    let score = "…";
    if (whiteCp !== null) score = (whiteCp > 0 ? "+" : "") + (whiteCp / 100).toFixed(2);
    else if (whiteMate !== null) score = (whiteMate > 0 ? "+" : "-") + "M" + Math.abs(whiteMate);

    const moves = [];
    try {
        const g = new Chess(fen);
        for (const u of pvUci.slice(0, PV_LENGTH)) {
            moves.push(g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }));
        }
    } catch (e) {
        // Keep whatever prefix of the PV was legal.
    }

    return {
        fen,
        multipv: parseInt(line.match(/\bmultipv (\d+)/)?.[1] ?? "1", 10),
        depth: parseInt(line.match(/\bdepth (\d+)/)?.[1] ?? "0", 10),
        whiteCp,
        whiteMate,
        score,
        moves,
    };
}

// One engine line: score badge, then numbered SAN moves; clicking a move plays the line up to it.
function EngineLine({ line, label, labelColor, onPlay }) {
    const [, side, , , , fullmove] = line.fen.split(" ");
    let moveNo = parseInt(fullmove, 10) || 1;
    let whiteToMove = side === "w";
    const whiteBetter = (line.whiteMate ?? line.whiteCp ?? 0) >= 0;

    return (
        <div className="flex items-start gap-2 text-xs min-w-0">
            {label && <span className={`font-bold uppercase tracking-wider w-8 shrink-0 pt-0.5 ${labelColor}`}>{label}</span>}
            <span className={`font-mono font-bold w-14 shrink-0 text-center rounded py-0.5 ${whiteBetter ? "bg-slate-100 text-slate-900" : "bg-slate-800 text-slate-100 border border-slate-700"}`}>
                {line.score}
            </span>
            <div className="font-mono text-slate-300 leading-5 min-w-0 truncate">
                {line.moves.map((m, i) => {
                    let prefix = "";
                    if (whiteToMove) prefix = `${moveNo}.`;
                    else if (i === 0) prefix = `${moveNo}…`;
                    if (!whiteToMove) moveNo++;
                    whiteToMove = !whiteToMove;
                    return (
                        <span key={i} className="mr-1">
                            {prefix && <span className="text-slate-600 mr-0.5">{prefix}</span>}
                            <span onClick={() => onPlay(line.moves.slice(0, i + 1))} className="cursor-pointer rounded px-0.5 hover:bg-slate-700 hover:text-white">
                                {m.san}
                            </span>
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

export default function AnalysisPage() {
    const { activeUrl, activeDbUrl } = useBot();
    const [game, setGame] = useState(new Chess());
    const [customFens, setCustomFens] = useState([]);
    const [recentGames, setRecentGames] = useState([]);
    const [selectedGame, setSelectedGame] = useState(null);
    const [moveHistory, setMoveHistory] = useState([]);
    const [currentPly, setCurrentPly] = useState(0);
    const [evals, setEvals] = useState({});
    const [orientation, setOrientation] = useState("white");

    const [liveAnalysis, setLiveAnalysis] = useState(false);
    // Latest parsed line per engine, keyed by MultiPV index: { stockfish: { 1: line, 2: line }, jewkiebot: { 1: line } }
    const [engineLines, setEngineLines] = useState({});
    const [multiPv, setMultiPv] = useState(3);
    const [showArrows, setShowArrows] = useState(true);
    const eventSourceRef = useRef(null);
    const lastLiveEvalRef = useRef({ cp: 0, mate: null });

    const [pgnInput, setPgnInput] = useState("");

    const [playerFilter, setPlayerFilter] = useState("");
    const [isFiltering, setIsFiltering] = useState(false);
    // The games list eats board space, so it starts collapsed on laptop-sized screens.
    const [showGames, setShowGames] = useState(() => window.innerWidth >= 1536);

    const [explorerData, setExplorerData] = useState(null);

    const boardAreaRef = useRef(null);
    const [boardSize, setBoardSize] = useState(480);

    useEffect(() => {
        const el = boardAreaRef.current;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            setBoardSize(Math.max(240, Math.floor(Math.min(height, width - EVAL_BAR_SPACE))));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        const fetchGames = async () => {
            try {
                let res;

                if (isFiltering && playerFilter.trim()) {
                    res = await fetch(`${activeDbUrl}/api/v1/chess/games/player/${encodeURIComponent(playerFilter.trim())}`).then(r => r.json());
                } else {
                    res = await getRecentGames(15, activeDbUrl);
                }
                const games = res?.data || res || [];
                setRecentGames(Array.isArray(games) ? games : []);
            } catch (err) {
                console.error("Failed to load games", err);
                setRecentGames([]);
            }
        };
        fetchGames();
    }, [activeDbUrl, isFiltering, playerFilter]);

    useEffect(() => {
        return () => stopStreaming();
    }, []);

    const stopStreaming = () => {
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }
    };

    const startStreaming = (fen) => {
        stopStreaming();
        setEngineLines({});
        const url = `${activeUrl}/api/engine/stream?fen=${encodeURIComponent(fen)}&depth=22&multipv=${multiPv}`;
        const es = new EventSource(url);

        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                // "bestmove" carries no score or PV; keep showing the last info line.
                if (!data.line?.startsWith("info")) return;
                const parsed = parseEngineLine(data.line, fen);
                if (!parsed || parsed.moves.length === 0) return;
                setEngineLines(prev => ({
                    ...prev,
                    [data.engine]: { ...prev[data.engine], [parsed.multipv]: parsed }
                }));
            } catch (e) {}
        };
        es.onerror = () => stopStreaming();
        eventSourceRef.current = es;
    };

    const getDisplayFen = () => {
        if (game) return game.fen();
        if (customFens.length === 0) return START_FEN;
        if (currentPly === 0) return START_FEN;
        return customFens[currentPly - 1] || START_FEN;
    };
    const displayFen = getDisplayFen();

    // Playing moves (on the board, from the explorer, or from an engine line) extends the
    // current line, branching off wherever we are, so the line can be stepped back through.
    const playMoves = (moves) => {
        // Same moves as the ones that follow in the loaded line: just step forward.
        const ahead = moveHistory.slice(currentPly, currentPly + moves.length);
        if (ahead.length === moves.length && ahead.every((h, i) => h === moves[i].san || h === moves[i].lan)) {
            goToPly(currentPly + moves.length);
            return;
        }

        const line = [...moveHistory.slice(0, currentPly), ...moves.map(m => m.san)];
        const replayed = replayLine(line);
        if (replayed) {
            setGame(replayed);
            setMoveHistory(line);
            setCurrentPly(line.length);
        } else {
            // History can't be replayed from the start position (e.g. odd DB game); explore from here.
            const g = new Chess(displayFen);
            moves.forEach(m => g.move(m.san));
            setGame(g);
            setMoveHistory([]);
            setCurrentPly(0);
        }
        setCustomFens([]);
        setEvals(prev => Object.fromEntries(Object.entries(prev).filter(([ply]) => Number(ply) <= currentPly)));
    };

    const handleMakeMove = (sourceSquare, targetSquare, promotion = "q") => {
        let move;
        try {
            move = new Chess(displayFen).move({ from: sourceSquare, to: targetSquare, promotion });
        } catch (e) {
            return false;
        }
        if (!move) return false;
        playMoves([move]);
        return true;
    };

    const handlePieceDrop = (sourceSquare, targetSquare, piece) => {
        const promotion = piece?.[1]?.toLowerCase() || "q";
        return handleMakeMove(sourceSquare, targetSquare, promotion);
    };

    useEffect(() => {
        if (liveAnalysis) {
            startStreaming(displayFen);
        } else {
            stopStreaming();
            setEngineLines({});
        }
    }, [liveAnalysis, displayFen, activeUrl, multiPv]);

    useEffect(() => {
        // Ignore stale responses when stepping through moves quickly.
        let cancelled = false;
        fetch(`${activeUrl}/api/analysis/explorer?fen=${encodeURIComponent(displayFen)}`)
            .then(res => res.json())
            .then(data => { if (!cancelled) setExplorerData(data); })
            .catch(err => console.error("Explorer fetch error", err));
        return () => { cancelled = true; };
    }, [displayFen, activeUrl]);

    const loadGameData = async (gameId) => {
        try {
            const [movesRes, evalsRes] = await Promise.all([
                getGameMoves(gameId, activeDbUrl),
                getGameEvals(gameId, activeDbUrl)
            ]);

            const moves = movesRes.data || movesRes || [];
            const history = [];
            const fens = [];

            const tempGame = new Chess();
            for (const m of moves) {
                history.push(m.uci);

                try {
                    tempGame.move(m.uci);
                } catch (e) {
                    console.error("Invalid move", m.uci, tempGame.fen());
                }

                if (m.fen_after) {
                    fens.push(m.fen_after);
                } else {
                    fens.push(tempGame.fen());
                }
            }

            const evalsMap = {};
            const evalsData = evalsRes.data || evalsRes || [];
            evalsData.forEach(e => {
                evalsMap[e.ply] = e;
            });

            setGame(null); // Bypass chess.js validation
            setCustomFens(fens);
            setMoveHistory(history);
            setCurrentPly(history.length);
            setEvals(evalsMap);
            setSelectedGame(gameId);
        } catch (err) {
            console.error("Error loading game details", err);
        }
    };

    const handlePgnLoad = () => {
        try {
            const newGame = new Chess();
            newGame.loadPgn(pgnInput);
            setGame(newGame);
            setCustomFens([]);
            setMoveHistory(newGame.history());
            setCurrentPly(newGame.history().length);
            setSelectedGame(null);
            setEvals({});
            setPgnInput("");
        } catch (e) {
            alert("Invalid PGN");
        }
    };

    const handleReset = () => {
        setGame(new Chess());
        setCustomFens([]);
        setMoveHistory([]);
        setCurrentPly(0);
        setSelectedGame(null);
        setEvals({});
    };

    const goToPly = (plyIndex) => {
        if (game) {
            const replayed = replayLine(moveHistory.slice(0, plyIndex));
            if (!replayed) return;
            setGame(replayed);
        }
        setCurrentPly(plyIndex);
    };

    const handlePrev = () => goToPly(Math.max(0, currentPly - 1));
    const handleNext = () => goToPly(Math.min(moveHistory.length, currentPly + 1));

    useEffect(() => {
        const onKey = (e) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (e.key === "ArrowLeft") handlePrev();
            else if (e.key === "ArrowRight") handleNext();
            else if (e.key === "Home") goToPly(0);
            else if (e.key === "End") goToPly(moveHistory.length);
            else if (e.key === "f") setOrientation(o => (o === "white" ? "black" : "white"));
            else return;
            e.preventDefault();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    const handleFilterSubmit = (e) => {
        e.preventDefault();
        setIsFiltering(!!playerFilter.trim());
    };

    // Calculate current evaluation to show in bar
    let currentEval = evals[currentPly]?.best_cp || 0;
    let isMate = evals[currentPly]?.is_mate;

    // Only trust lines computed for the position on the board (state can lag one render behind).
    const linesFor = (engine) => Object.values(engineLines[engine] ?? {})
        .filter(l => l.fen === displayFen && l.multipv <= multiPv)
        .sort((a, b) => a.multipv - b.multipv);
    const sfLines = linesFor("stockfish");
    const jbLine = linesFor("jewkiebot")[0];
    const depth = Math.max(0, ...sfLines.map(l => l.depth));

    if (liveAnalysis) {
        // Hold the previous eval until the engine reports on the new position, so the bar doesn't snap to 0.
        const best = sfLines[0] ?? jbLine;
        if (best) lastLiveEvalRef.current = { cp: best.whiteCp ?? 0, mate: best.whiteMate };
        const { cp, mate } = lastLiveEvalRef.current;
        isMate = mate !== null;
        currentEval = isMate ? mate : cp;
    }

    // react-chessboard re-syncs arrows whenever the array identity changes, so memo on the content.
    const arrowKey = JSON.stringify(!liveAnalysis || !showArrows ? [] : (() => {
        const out = [];
        const seen = new Set();
        sfLines.forEach((l, i) => {
            const m = l.moves[0];
            if (!seen.has(m.from + m.to)) out.push([m.from, m.to, SF_ARROW_COLORS[i]]);
            seen.add(m.from + m.to);
        });
        const jb = jbLine?.moves[0];
        if (jb && !seen.has(jb.from + jb.to)) out.push([jb.from, jb.to, JB_ARROW_COLOR]);
        return out;
    })());
    const arrows = useMemo(() => JSON.parse(arrowKey), [arrowKey]);

    let evalBarHeight = 50;
    if (isMate) {
        evalBarHeight = currentEval > 0 ? 100 : 0;
    } else {
        evalBarHeight = 50 + (currentEval / 1000) * 50;
        evalBarHeight = Math.max(5, Math.min(95, evalBarHeight));
    }

    // Index of each row's white ply; the row shows that ply and the next.
    const moveRows = [];
    for (let i = 0; i < moveHistory.length; i += 2) moveRows.push(i);

    const iconBtn = "p-1.5 hover:bg-slate-800 rounded-lg transition-colors text-slate-400 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent";

    return (
        <div className="animate-in fade-in duration-500 h-[calc(100vh-8rem)] min-h-[480px] flex flex-col gap-3">
            <header className="flex flex-wrap justify-between items-center gap-3 shrink-0">
                <div className="flex items-center gap-3">
                    <button onClick={() => setShowGames(s => !s)} className={iconBtn} title={showGames ? "Hide games" : "Show games"}>
                        {showGames ? <PanelLeftClose size={20} /> : <PanelLeftOpen size={20} />}
                    </button>
                    <h1 className="text-2xl font-black text-white tracking-tight">Game Analysis</h1>
                </div>
                <div className="flex items-center gap-2">
                    <input
                        type="text"
                        placeholder="Paste PGN here..."
                        value={pgnInput}
                        onChange={(e) => setPgnInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handlePgnLoad()}
                        className="bg-slate-900 border border-slate-700 text-sm text-white px-3 py-1.5 rounded-lg w-56 focus:outline-none focus:border-blue-500"
                    />
                    <button onClick={handlePgnLoad} className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-2">
                        <Upload size={14}/> Load PGN
                    </button>
                </div>
            </header>

            <div className="flex-1 flex gap-4 min-h-0">
                {/* Left Sidebar: Recent Games (collapsible) */}
                {showGames && (
                    <div className="w-56 bg-slate-900 border border-slate-800 rounded-2xl shadow-lg flex flex-col overflow-hidden shrink-0">
                        <div className="p-3 border-b border-slate-800 bg-slate-900/50 flex flex-col gap-2">
                            <h2 className="font-bold text-white text-sm flex items-center gap-2">
                                <Activity size={16} className="text-blue-400"/> {isFiltering ? 'Player Games' : 'Recent Games'}
                            </h2>
                            <form onSubmit={handleFilterSubmit} className="flex gap-2">
                                <input
                                    type="text"
                                    placeholder="Username..."
                                    value={playerFilter}
                                    onChange={e => {
                                        setPlayerFilter(e.target.value);
                                        if (!e.target.value) setIsFiltering(false);
                                    }}
                                    className="bg-slate-950 border border-slate-700 text-xs text-white px-2 py-1 rounded w-full focus:outline-none focus:border-blue-500"
                                />
                                <button type="submit" className="bg-slate-700 hover:bg-slate-600 text-xs px-2 rounded font-semibold transition-colors">Go</button>
                            </form>
                        </div>
                        <div className="flex-1 overflow-auto p-2 flex flex-col gap-1">
                            {recentGames.map(g => (
                                <button
                                    key={g.id}
                                    onClick={() => loadGameData(g.id)}
                                    className={`text-left p-2 rounded-lg transition-colors text-xs ${selectedGame === g.id ? 'bg-blue-600/20 border border-blue-500/30' : 'hover:bg-slate-800 border border-transparent'}`}
                                >
                                    <div className="font-semibold text-slate-200 truncate">{g.white_name || g.white_username || g.white_id}</div>
                                    <div className="font-semibold text-slate-200 truncate">{g.black_name || g.black_username || g.black_id}</div>
                                    <div className="text-[10px] text-slate-500 mt-0.5">{new Date(g.created_at).toLocaleDateString()} • {g.source}</div>
                                </button>
                            ))}
                            {recentGames.length === 0 && <p className="text-center italic mt-4 text-slate-500 text-sm">No games found.</p>}
                        </div>
                    </div>
                )}

                {/* Center: Board & Eval Bar, sized to whatever space is left */}
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                    <div ref={boardAreaRef} className="flex-1 min-h-0 overflow-hidden flex justify-center items-start">
                        <div className="flex gap-2" style={{ height: boardSize }}>
                            {/* Eval Bar */}
                            <div className="w-8 bg-[#2b2b2b] rounded-lg overflow-hidden flex flex-col justify-end relative shadow-inner border border-slate-800">
                                <div
                                    className="bg-white transition-all duration-500 ease-in-out w-full"
                                    style={{ height: `${evalBarHeight}%` }}
                                />
                                <div className="absolute inset-0 flex flex-col justify-between pointer-events-none py-1">
                                    <span className="text-center text-[10px] font-bold text-slate-300 z-10 drop-shadow-md">
                                        {evalBarHeight <= 50 ? (isMate ? `M${Math.abs(currentEval)}` : (currentEval/100).toFixed(1)) : ''}
                                    </span>
                                    <span className="text-center text-[10px] font-bold text-slate-800 z-10 drop-shadow-md">
                                        {evalBarHeight > 50 ? (isMate ? `M${Math.abs(currentEval)}` : '+' + (currentEval/100).toFixed(1)) : ''}
                                    </span>
                                </div>
                            </div>

                            <Chessboard
                                position={displayFen}
                                onPieceDrop={handlePieceDrop}
                                boardWidth={boardSize}
                                boardOrientation={orientation}
                                customArrows={arrows}
                                animationDuration={200}
                                customBoardStyle={{
                                    borderRadius: "8px",
                                    boxShadow: "0 10px 25px rgba(0, 0, 0, 0.5)"
                                }}
                            />
                        </div>
                    </div>

                    {/* Player Controls */}
                    <div className="shrink-0 self-center flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-xl px-2 py-1 shadow-lg">
                        <button onClick={handleReset} className={iconBtn} title="New board">
                            <RotateCcw size={18} />
                        </button>
                        <button onClick={() => goToPly(0)} disabled={currentPly === 0} className={iconBtn} title="Start (Home)">
                            <ChevronsLeft size={20} />
                        </button>
                        <button onClick={handlePrev} disabled={currentPly === 0} className={iconBtn} title="Back (←)">
                            <ChevronLeft size={20} />
                        </button>
                        <span className="font-mono text-sm text-slate-300 w-16 text-center">{currentPly} / {moveHistory.length}</span>
                        <button onClick={handleNext} disabled={currentPly >= moveHistory.length} className={iconBtn} title="Forward (→)">
                            <ChevronRight size={20} />
                        </button>
                        <button onClick={() => goToPly(moveHistory.length)} disabled={currentPly >= moveHistory.length} className={iconBtn} title="End (End)">
                            <ChevronsRight size={20} />
                        </button>
                        <button onClick={() => setOrientation(o => (o === "white" ? "black" : "white"))} className={iconBtn} title="Flip board (F)">
                            <Repeat size={18} />
                        </button>
                    </div>
                </div>

                {/* Right: explorer gets the room; engines and moves stay compact */}
                <div className="w-[340px] xl:w-[400px] shrink-0 flex flex-col gap-3 min-h-0">
                    <OpeningExplorer
                        data={explorerData}
                        onMoveClick={(uci) => {
                            const from = uci.substring(0, 2);
                            const to = uci.substring(2, 4);
                            const prom = uci.length > 4 ? uci.substring(4) : "q";
                            handleMakeMove(from, to, prom);
                        }}
                    />

                    <div className="shrink-0 bg-slate-900 border border-slate-800 rounded-xl shadow-lg">
                        <div className="px-3 py-2 border-b border-slate-800 flex justify-between items-center gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                                <h3 className="text-xs font-bold tracking-widest text-slate-400 uppercase">Engines</h3>
                                {liveAnalysis && depth > 0 && <span className="font-mono text-[11px] text-slate-500">d{depth}</span>}
                            </div>
                            <div className="flex items-center gap-1.5">
                                <div className="flex text-[11px] font-bold bg-slate-950 rounded-md border border-slate-800" title="Number of Stockfish lines">
                                    {[1, 2, 3, 5].map(n => (
                                        <button
                                            key={n}
                                            onClick={() => setMultiPv(n)}
                                            className={`px-1.5 py-0.5 rounded ${multiPv === n ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                                        >
                                            {n}
                                        </button>
                                    ))}
                                </div>
                                <button
                                    onClick={() => setShowArrows(s => !s)}
                                    className={`p-1 rounded-md border transition-colors ${showArrows ? 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10' : 'border-slate-800 text-slate-500 hover:text-slate-300'}`}
                                    title={showArrows ? "Hide arrows" : "Show arrows"}
                                >
                                    <MoveUpRight size={14} />
                                </button>
                                <button
                                    onClick={() => setLiveAnalysis(!liveAnalysis)}
                                    className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold transition-all ${liveAnalysis ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-green-500/20 text-green-400 border border-green-500/30'}`}
                                >
                                    {liveAnalysis ? <><Square size={10} fill="currentColor"/> Stop</> : <><Play size={10} fill="currentColor"/> Analyze</>}
                                </button>
                            </div>
                        </div>
                        <div className="px-3 py-2 flex flex-col gap-1.5">
                            {!liveAnalysis && <p className="text-slate-600 italic text-xs">Engines off — press Analyze.</p>}
                            {liveAnalysis && sfLines.length === 0 && !jbLine && <p className="text-slate-500 italic text-xs">Thinking…</p>}
                            {sfLines.map(l => (
                                <EngineLine key={l.multipv} line={l} label={l.multipv === 1 ? "SF" : ""} labelColor="text-blue-400" onPlay={playMoves} />
                            ))}
                            {jbLine && (
                                <div className={sfLines.length ? "border-t border-slate-800 pt-1.5" : ""}>
                                    <EngineLine line={jbLine} label="JB" labelColor="text-purple-400" onPlay={playMoves} />
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="h-40 shrink-0 bg-slate-900 border border-slate-800 rounded-xl shadow-lg flex flex-col overflow-hidden">
                        <h3 className="px-3 py-2 border-b border-slate-800 text-xs font-bold tracking-widest text-slate-400 uppercase">Moves</h3>
                        <div className="flex-1 overflow-auto px-2 py-1 font-mono text-sm">
                            {moveRows.length === 0 && <p className="text-slate-600 italic text-xs p-1">Play a move or pick one from the explorer.</p>}
                            {moveRows.map(i => (
                                <div key={i} className="flex gap-1">
                                    <span className="w-8 text-slate-600 text-right pr-1">{i / 2 + 1}.</span>
                                    {[i, i + 1].map(j => j < moveHistory.length && (
                                        <span
                                            key={j}
                                            onClick={() => goToPly(j + 1)}
                                            className={`w-20 cursor-pointer px-1.5 rounded transition-colors ${j + 1 === currentPly ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}
                                        >
                                            {moveHistory[j]}
                                        </span>
                                    ))}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
