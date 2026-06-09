import React, { useState, useEffect, useRef } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { getRecentGames, getGameMoves, getGameEvals } from "../services/api.js";
import { Play, Square, Activity, ChevronRight, ChevronLeft, Upload } from "lucide-react";
import { useBot } from "../context/BotContext.jsx";

export default function AnalysisPage() {
    const { activeUrl, activeDbUrl } = useBot();
    const [game, setGame] = useState(new Chess());
    const [customFens, setCustomFens] = useState([]);
    const [recentGames, setRecentGames] = useState([]);
    const [selectedGame, setSelectedGame] = useState(null);
    const [moveHistory, setMoveHistory] = useState([]);
    const [currentPly, setCurrentPly] = useState(0);
    const [evals, setEvals] = useState({});
    
    const [liveAnalysis, setLiveAnalysis] = useState(false);
    const [enginesOutput, setEnginesOutput] = useState({ stockfish: "", jewkiebot: "" });
    const eventSourceRef = useRef(null);

    const [pgnInput, setPgnInput] = useState("");

    // Fetch recent games on load
    useEffect(() => {
        getRecentGames(15, activeDbUrl)
            .then(res => setRecentGames(res.data))
            .catch(err => console.error("Failed to load recent games", err));
    }, [activeDbUrl]);

    // Cleanup SSE
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
        const url = `${activeUrl}/api/engine/stream?fen=${encodeURIComponent(fen)}&depth=22`;
        const es = new EventSource(url);
        
        es.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                setEnginesOutput(prev => ({
                    ...prev,
                    [data.engine]: data.line
                }));
            } catch (e) {}
        };
        es.onerror = () => stopStreaming();
        eventSourceRef.current = es;
    };

    const getDisplayFen = () => {
        if (game) return game.fen();
        if (customFens.length === 0) return "start";
        if (currentPly === 0) return customFens[0];
        return customFens[currentPly - 1];
    };

    useEffect(() => {
        if (liveAnalysis) {
            startStreaming(getDisplayFen());
        } else {
            stopStreaming();
            setEnginesOutput({ stockfish: "", jewkiebot: "" });
        }
    }, [liveAnalysis, getDisplayFen(), activeUrl]);

    const loadGameData = async (gameId) => {
        try {
            const [movesRes, evalsRes] = await Promise.all([
                getGameMoves(gameId, activeDbUrl),
                getGameEvals(gameId, activeDbUrl)
            ]);
            
            const moves = movesRes.data || [];
            const history = [];
            const fens = [];
            
            for (const m of moves) {
                history.push(m.uci);
                fens.push(m.fen_after);
            }
            
            const evalsMap = {};
            (evalsRes.data || []).forEach(e => {
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

    const goToPly = (plyIndex) => {
        if (game) {
            const newGame = new Chess();
            for (let i = 0; i < plyIndex; i++) {
                newGame.move(moveHistory[i]);
            }
            setGame(newGame);
        }
        setCurrentPly(plyIndex);
    };

    const handlePrev = () => {
        const minPly = game ? 0 : 1;
        goToPly(Math.max(minPly, currentPly - 1));
    };

    const handleNext = () => {
        goToPly(Math.min(moveHistory.length, currentPly + 1));
    };

    // Calculate current evaluation to show in bar
    const currentEval = evals[currentPly]?.best_cp || 0;
    const isMate = evals[currentPly]?.is_mate;
    let evalBarHeight = 50;
    if (isMate) {
        evalBarHeight = currentEval > 0 ? 100 : 0;
    } else {
        evalBarHeight = 50 + (currentEval / 1000) * 50;
        evalBarHeight = Math.max(5, Math.min(95, evalBarHeight));
    }

    return (
        <div className="space-y-6 animate-in fade-in duration-500 h-[calc(100vh-8rem)] flex flex-col">
            <header className="flex justify-between items-center shrink-0">
                <div>
                    <h1 className="text-3xl font-black text-white mb-2 tracking-tight">Game Analysis</h1>
                    <p className="text-slate-400">Explore games, evaluate positions, and stream live engine analysis.</p>
                </div>
                <div className="flex items-center gap-2">
                    <input 
                        type="text" 
                        placeholder="Paste PGN here..." 
                        value={pgnInput}
                        onChange={(e) => setPgnInput(e.target.value)}
                        className="bg-slate-900 border border-slate-700 text-sm text-white px-4 py-2 rounded-lg w-64 focus:outline-none focus:border-blue-500"
                    />
                    <button onClick={handlePgnLoad} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg text-sm font-semibold flex items-center gap-2">
                        <Upload size={16}/> Load PGN
                    </button>
                </div>
            </header>

            <div className="flex-1 flex gap-8 min-h-0">
                {/* Left Sidebar: Recent Games */}
                <div className="w-64 bg-slate-900 border border-slate-800 rounded-2xl shadow-lg flex flex-col overflow-hidden shrink-0">
                    <div className="p-4 border-b border-slate-800 bg-slate-900/50">
                        <h2 className="font-bold text-white flex items-center gap-2">
                            <Activity size={18} className="text-blue-400"/> Recent Games
                        </h2>
                    </div>
                    <div className="flex-1 overflow-auto p-2 flex flex-col gap-1">
                        {recentGames.map(g => (
                            <button 
                                key={g.id} 
                                onClick={() => loadGameData(g.id)}
                                className={`text-left p-3 rounded-lg transition-colors text-sm ${selectedGame === g.id ? 'bg-blue-600/20 border border-blue-500/30' : 'hover:bg-slate-800 border border-transparent'}`}
                            >
                                <div className="font-semibold text-slate-200 truncate">{g.white_name || g.white_id}</div>
                                <div className="font-semibold text-slate-200 truncate">{g.black_name || g.black_id}</div>
                                <div className="text-xs text-slate-500 mt-1">{new Date(g.created_at).toLocaleDateString()} • {g.source}</div>
                            </button>
                        ))}
                        {recentGames.length === 0 && <p className="text-center italic mt-4 text-slate-500 text-sm">No games found.</p>}
                    </div>
                </div>

                {/* Center: Board & Eval Bar */}
                <div className="flex shrink-0 gap-4">
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

                    <div className="w-[600px] flex flex-col gap-4">
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
                            <Chessboard 
                                position={getDisplayFen()} 
                                animationDuration={200}
                                customBoardStyle={{
                                    borderRadius: "8px",
                                    boxShadow: "0 10px 25px rgba(0, 0, 0, 0.5)"
                                }}
                            />
                        </div>

                        {/* Player Controls */}
                        <div className="flex items-center justify-center gap-4 bg-slate-900 border border-slate-800 rounded-xl p-3 shadow-lg">
                            <button onClick={handlePrev} className="p-2 hover:bg-slate-800 rounded-lg transition-colors text-slate-400 hover:text-white">
                                <ChevronLeft size={24} />
                            </button>
                            <span className="font-mono text-slate-300 w-16 text-center">{currentPly} / {moveHistory.length}</span>
                            <button onClick={handleNext} className="p-2 hover:bg-slate-800 rounded-lg transition-colors text-slate-400 hover:text-white">
                                <ChevronRight size={24} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Right: Analysis details */}
                <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl shadow-lg flex flex-col overflow-hidden min-w-0">
                    <div className="p-4 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
                        <h2 className="font-bold text-white flex items-center gap-2">Live Analysis</h2>
                        <button 
                            onClick={() => setLiveAnalysis(!liveAnalysis)}
                            className={`flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold transition-all ${liveAnalysis ? 'bg-red-500/20 text-red-400 border border-red-500/30' : 'bg-green-500/20 text-green-400 border border-green-500/30'}`}
                        >
                            {liveAnalysis ? <><Square size={12} fill="currentColor"/> Stop Engine</> : <><Play size={12} fill="currentColor"/> Start Engine</>}
                        </button>
                    </div>
                    
                    <div className="flex-1 p-4 flex flex-col gap-4 overflow-auto">
                        {/* JewkieBot Stream */}
                        <div className="bg-slate-950 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-inner">
                            <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                                <h3 className="text-xs font-bold tracking-widest text-purple-400 uppercase">JewkieBot</h3>
                                {liveAnalysis && <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />}
                            </div>
                            <div className="p-4 overflow-x-auto">
                                <pre className="font-mono text-xs text-slate-300">
                                    {enginesOutput.jewkiebot || "Waiting for stream..."}
                                </pre>
                            </div>
                        </div>

                        {/* Stockfish Stream */}
                        <div className="bg-slate-950 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-inner">
                            <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                                <h3 className="text-xs font-bold tracking-widest text-blue-400 uppercase">Stockfish 16.1</h3>
                                {liveAnalysis && <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />}
                            </div>
                            <div className="p-4 overflow-x-auto">
                                <pre className="font-mono text-xs text-slate-300">
                                    {enginesOutput.stockfish || "Waiting for stream..."}
                                </pre>
                            </div>
                        </div>

                        {/* Move History Text */}
                        <div className="mt-4 flex-1">
                            <h3 className="text-xs font-bold tracking-widest text-slate-500 uppercase mb-3 px-1">Move Record</h3>
                            <div className="flex flex-wrap gap-1 px-1">
                                {moveHistory.map((m, i) => (
                                    <span 
                                        key={i} 
                                        onClick={() => goToPly(i+1)}
                                        className={`cursor-pointer px-1.5 py-0.5 rounded text-sm font-mono transition-colors ${i+1 === currentPly ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'}`}
                                    >
                                        {i % 2 === 0 ? `${Math.floor(i/2) + 1}. ` : ''}{m}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
