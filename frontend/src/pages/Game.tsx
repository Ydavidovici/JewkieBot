import React, { useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { go, resetGame } from "../services/api.js";
import { useBot } from "../context/BotContext.jsx";
import { Play, RotateCcw, Cpu, Trophy } from "lucide-react";

export default function Game() {
    const { activeUrl } = useBot();
    const [game, setGame] = useState(() => new Chess());
    const [gameStatus, setGameStatus] = useState(null); // "Checkmate", "Draw", etc.

    const [engineThinking, setEngineThinking] = useState(false);
    const [lastMove, setLastMove] = useState(null);
    const [engineDepth, setEngineDepth] = useState(10);

    const checkGameOver = (gameInstance) => {
        if (gameInstance.isCheckmate()) {
            const winner = gameInstance.turn() === "w" ? "Black" : "White";
            setGameStatus(`Checkmate! ${winner} wins.`);
            return true;
        }
        if (gameInstance.isDraw()) {
            setGameStatus("Draw!");
            return true;
        }
        if (gameInstance.isGameOver()) {
            setGameStatus("Game Over!");
            return true;
        }
        return false;
    };

    const safeGameMutate = (modify) => {
        setGame((g) => {
            const update = new Chess(g.fen());
            modify(update);
            return update;
        });
    };

    const makeEngineMove = async (currentFen) => {
        if (checkGameOver(new Chess(currentFen))) return;

        setEngineThinking(true);
        try {
            const response = await go({
                fen: currentFen,
                options: { depth: engineDepth }
            }, activeUrl);

            const bestMove = response.bestMove;

            if (!bestMove || bestMove.length < 4 || bestMove.includes("`")) {
                console.warn("Engine returned invalid move (Resignation?):", bestMove);
                return;
            }

            safeGameMutate((g) => {
                try {
                    const moveResult = g.move({
                        from: bestMove.substring(0, 2),
                        to: bestMove.substring(2, 4),
                        promotion: bestMove.length > 4 ? bestMove[4] : 'q',
                    });

                    if (moveResult) {
                        setLastMove(bestMove);
                        checkGameOver(g);
                    }
                } catch (e) {
                    console.error("Engine tried illegal move:", bestMove);
                }
            });
        } catch (error) {
            console.error("Engine API failed:", error);
        } finally {
            setEngineThinking(false);
        }
    };

    const onDrop = (sourceSquare, targetSquare) => {
        if (engineThinking || gameStatus) return false;

        const gameCopy = new Chess(game.fen());
        let move = null;

        try {
            move = gameCopy.move({
                from: sourceSquare,
                to: targetSquare,
                promotion: "q",
            });
        } catch (e) {
            return false;
        }

        setGame(gameCopy);

        if (checkGameOver(gameCopy)) {
            return true;
        }

        const newFen = gameCopy.fen();
        setTimeout(() => {
            makeEngineMove(newFen);
        }, 200);

        return true;
    };

    const handleReset = async () => {
        setGame(new Chess());
        setLastMove(null);
        setGameStatus(null);
        setEngineThinking(false);
        await resetGame(activeUrl);
    };

    return (
        <div className="animate-in fade-in duration-500">
            <header className="mb-8">
                <h1 className="text-3xl font-black text-white mb-2 tracking-tight">Play vs Engine</h1>
                <p className="text-slate-400">Play directly against the active bot on the backend.</p>
            </header>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 relative flex justify-center bg-slate-900 border border-slate-800 p-8 rounded-2xl shadow-xl">
                    <div className="w-full max-w-[600px] aspect-square">
                        <Chessboard
                            position={game.fen()}
                            onPieceDrop={onDrop}
                            boardOrientation="white"
                            customDarkSquareStyle={{ backgroundColor: "#334155" }}
                            customLightSquareStyle={{ backgroundColor: "#94a3b8" }}
                            animationDuration={200}
                        />
                    </div>

                    {gameStatus && (
                        <div className="absolute inset-0 bg-slate-950/80 flex items-center justify-center rounded-2xl z-10 backdrop-blur-md">
                            <div className="bg-slate-900 p-8 rounded-2xl border border-slate-700 shadow-2xl text-center transform scale-110">
                                <Trophy className="w-16 h-16 text-yellow-500 mx-auto mb-4 drop-shadow-[0_0_15px_rgba(234,179,8,0.5)]" />
                                <h2 className="text-3xl font-bold text-white mb-2">{gameStatus}</h2>
                                <button
                                    onClick={handleReset}
                                    className="mt-6 px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-bold transition-all shadow-lg"
                                >
                                    New Game
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="space-y-6">
                    <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl">
                        <h2 className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-6 flex items-center gap-2">
                            <Cpu size={16} /> Engine Status
                        </h2>

                        <div className="flex items-center justify-between mb-8">
                            <div className="flex items-center gap-3">
                                <div className={`w-3 h-3 rounded-full ${engineThinking ? "bg-yellow-500 shadow-[0_0_10px_rgba(234,179,8,0.8)] animate-pulse" : "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.8)]"}`} />
                                <span className="font-mono text-sm text-slate-200">
                                    {engineThinking ? "Thinking..." : "Waiting for move"}
                                </span>
                            </div>
                            {lastMove && (
                                <span className="bg-slate-800 px-3 py-1 rounded-md text-xs font-mono text-blue-400 border border-slate-700">
                                    Last: {lastMove}
                                </span>
                            )}
                        </div>

                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 block">Search Depth (Difficulty)</label>
                                <input
                                    type="range"
                                    min="1" max="20"
                                    value={engineDepth}
                                    onChange={(e) => setEngineDepth(parseInt(e.target.value))}
                                    className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500 mb-2"
                                />
                                <div className="flex justify-between text-xs text-slate-500 mt-1">
                                    <span>Fast (1)</span>
                                    <span className="text-white font-bold bg-slate-800 px-2 py-0.5 rounded">{engineDepth} Ply</span>
                                    <span>Strong (20)</span>
                                </div>
                            </div>
                        </div>

                        <button
                            onClick={handleReset}
                            className="w-full mt-8 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 rounded-xl flex items-center justify-center gap-2 transition-all text-sm font-bold text-slate-300 hover:text-white shadow-sm"
                        >
                            <RotateCcw size={16} /> Reset Game
                        </button>
                    </div>

                    <div className="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl flex flex-col h-72">
                        <h3 className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-4">Move History</h3>
                        <div className="text-sm font-mono text-slate-400 leading-relaxed overflow-y-auto flex-1 pr-2 custom-scrollbar">
                            {game.history().map((move, i) => (
                                <span key={i} className={i % 2 === 0 ? "text-slate-200" : "mr-3"}>
                                    {i % 2 === 0 ? `${Math.floor(i/2) + 1}. ` : ""}{move}
                                </span>
                            ))}
                            {game.history().length === 0 && <span className="opacity-50 italic">No moves yet. Play a move!</span>}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}