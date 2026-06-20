import React, { useState, useEffect } from "react";
import { useBot } from "../context/BotContext.jsx";
import {
    startLichessBot, stopLichessBot, createChallenge,
    createOpenChallenge, createAiChallenge, challengeWeakestBot,
    startAutoplay, stopAutoplay, getOpenings
} from "../services/api.js";
import { Play, Square, Swords, Bot, Globe, Target, Flame } from "lucide-react";

export default function LichessPage() {
    const { activeUrl, activeStatus, refreshActive } = useBot();
    const isRunning = activeStatus?.lichess?.running;
    const botProfile = activeStatus?.lichess?.profile;
    const activeGames = activeStatus?.lichess?.activeGames || [];

    const [token, setToken] = useState("");
    const [statusMessage, setStatusMessage] = useState("");
    const [error, setError] = useState(null);

    const [opponent, setOpponent] = useState("maia1");
    const [stockfishLevel, setStockfishLevel] = useState(1);
    
    const [openings, setOpenings] = useState({});

    useEffect(() => {
        getOpenings(activeUrl)
            .then(res => setOpenings(res))
            .catch(console.error);
    }, [activeUrl]);

    // Comprehensive Autoplay Configuration State
    const [autoplayConfig, setAutoplayConfig] = useState({
        target: 1,           // Concurrent games to maintain
        limit: 180,          // Base time in seconds
        increment: 2,        // Increment in seconds
        rated: true,         // Rated or Casual
        mode: "near",        // Matchmaking mode
        window: 200,         // Rating window
        whiteOpeningId: "balanced",
        blackOpeningId: "balanced"
    });

    useEffect(() => {
        if (activeStatus?.lichess?.autoplay?.enabled) {
            setAutoplayConfig(prev => ({
                ...prev,
                target: activeStatus.lichess.autoplay.target,
                limit: activeStatus.lichess.autoplay.limit,
                increment: activeStatus.lichess.autoplay.increment,
                rated: activeStatus.lichess.autoplay.rated,
                mode: activeStatus.lichess.autoplay.mode,
                window: activeStatus.lichess.autoplay.window,
                whiteOpeningId: activeStatus.lichess.autoplay.whiteOpeningId || "balanced",
                blackOpeningId: activeStatus.lichess.autoplay.blackOpeningId || "balanced"
            }));
        }
    }, [activeStatus?.lichess?.autoplay]);

    const executeAction = async (msg, actionFn) => {
        setError(null);
        setStatusMessage(msg);
        try {
            const res = await actionFn();
            setStatusMessage(res?.message || "Action completed!");
            refreshActive();
        } catch (err) {
            setError(err.response?.data?.error || err.message);
            setStatusMessage("");
        }
    };

    const handleStart = () => executeAction("Starting...", () => startLichessBot(token || undefined, activeUrl));
    const handleStop = () => executeAction("Stopping...", () => stopLichessBot(activeUrl));
    const handleBotChallenge = () => executeAction(`Challenging ${opponent}...`, () => createChallenge(opponent, 180, 0, activeUrl));
    const handleOpenChallenge = () => executeAction("Creating Open Challenge...", () => createOpenChallenge(180, 0, activeUrl));
    const handleAiChallenge = () => executeAction(`Starting game vs Stockfish L${stockfishLevel}...`, () => createAiChallenge(stockfishLevel, 180, 0, activeUrl));
    const handleWeakestChallenge = () => executeAction("Scanning for weakest bot...", () => challengeWeakestBot(180, 0, activeUrl));

    const handleAutoplayToggle = () => {
        if (activeStatus?.lichess?.autoplay?.enabled) {
            executeAction("Stopping Autoplay...", () => stopAutoplay(activeUrl));
        } else {
            executeAction(`Starting Autoplay (Target: ${autoplayConfig.target} games)...`, () => startAutoplay(autoplayConfig, activeUrl));
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-500 max-w-5xl mx-auto">
            <header>
                <h1 className="text-3xl font-black text-white mb-2 tracking-tight">Lichess Bot Control</h1>
                <p className="text-slate-400">Manage the active Lichess bot identity and dispatch challenges.</p>
            </header>

            {/* Master Control */}
            <div className={`bg-slate-900 border-2 rounded-2xl p-6 shadow-xl transition-colors duration-300 ${isRunning ? 'border-green-500/50' : 'border-red-500/50'}`}>
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div>
                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                            Status: <span className={isRunning ? "text-green-400" : "text-red-400"}>{isRunning ? "ONLINE" : "OFFLINE"}</span>
                        </h2>
                        {botProfile && <p className="text-slate-400 mt-1">Logged in as: <strong className="text-white font-mono">{botProfile}</strong></p>}
                    </div>
                    {isRunning ? (
                        <button onClick={handleStop} className="bg-red-600 hover:bg-red-500 text-white px-6 py-2.5 rounded-lg font-bold flex items-center gap-2 transition-all">
                            <Square size={18} fill="currentColor" /> Stop Bot
                        </button>
                    ) : (
                        <div className="flex w-full md:w-auto gap-3">
                            <input 
                                type="password" 
                                placeholder="Lichess Token (Optional)" 
                                value={token} 
                                onChange={(e) => setToken(e.target.value)} 
                                className="bg-slate-800 border border-slate-700 text-white px-4 py-2.5 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none flex-1 md:w-64"
                            />
                            <button onClick={handleStart} className="bg-green-600 hover:bg-green-500 text-white px-6 py-2.5 rounded-lg font-bold flex items-center gap-2 transition-all shadow-lg">
                                <Play size={18} fill="currentColor" /> Start Bot
                            </button>
                        </div>
                    )}
                </div>
                {statusMessage && <p className="mt-4 text-sm text-blue-400 font-medium">{statusMessage}</p>}
                {error && <p className="mt-4 text-sm text-red-400 font-medium flex items-center gap-2"><Target size={16} /> {error}</p>}
            </div>

            {/* Actions Grid */}
            <div className={`grid grid-cols-1 md:grid-cols-2 gap-6 transition-opacity duration-300 ${!isRunning ? 'opacity-50 pointer-events-none' : ''}`}>
                <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-lg hover:border-slate-700 transition-colors">
                    <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2"><Swords size={20} className="text-blue-400"/> Vs Specific Bot</h3>
                    <div className="flex gap-3">
                        <input type="text" value={opponent} onChange={(e) => setOpponent(e.target.value)} placeholder="username" className="bg-slate-800 border border-slate-700 text-white px-4 py-2 rounded-lg flex-1 outline-none focus:ring-1 focus:ring-blue-500" />
                        <button onClick={handleBotChallenge} className="bg-blue-600 hover:bg-blue-500 text-white px-6 py-2 rounded-lg font-bold shadow-md">Play</button>
                    </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-lg hover:border-slate-700 transition-colors">
                    <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2"><Bot size={20} className="text-purple-400"/> Vs Stockfish AI</h3>
                    <div className="flex gap-3 items-center">
                        <select value={stockfishLevel} onChange={(e) => setStockfishLevel(e.target.value)} className="bg-slate-800 border border-slate-700 text-white px-4 py-2.5 rounded-lg flex-1 outline-none focus:ring-1 focus:ring-purple-500">
                            {[1,2,3,4,5,6,7,8].map(l => <option key={l} value={l}>Level {l}</option>)}
                        </select>
                        <button onClick={handleAiChallenge} className="bg-purple-600 hover:bg-purple-500 text-white px-6 py-2.5 rounded-lg font-bold shadow-md">Play AI</button>
                    </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-lg hover:border-slate-700 transition-colors">
                    <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2"><Globe size={20} className="text-green-400"/> Open Challenge</h3>
                    <p className="text-sm text-slate-400 mb-4">Create a public 3+0 rated game anyone can join.</p>
                    <button onClick={handleOpenChallenge} className="w-full bg-green-600 hover:bg-green-500 text-white py-3 rounded-xl font-bold shadow-md">Create Open Challenge</button>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-lg hover:border-slate-700 transition-colors">
                    <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2"><Flame size={20} className="text-red-400"/> Hunt Weakest Bot</h3>
                    <p className="text-sm text-slate-400 mb-4">Scans online bots for the lowest rating and challenges them.</p>
                    <button onClick={handleWeakestChallenge} className="w-full bg-red-600 hover:bg-red-500 text-white py-3 rounded-xl font-bold shadow-md">Find & Destroy</button>
                </div>

                <div className="bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-lg md:col-span-2 hover:border-slate-700 transition-colors">
                    <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2"><Target size={20} className="text-yellow-400"/> Autoplay Manager</h3>
                    <p className="text-sm text-slate-400 mb-6">Automatically seek and play games to continuously maintain your target concurrent games.</p>
                    
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 bg-slate-800/50 p-6 rounded-xl border border-slate-700 mb-6">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Concurrent Games Target</label>
                            <input type="number" min="1" max="20" value={autoplayConfig.target} onChange={(e) => setAutoplayConfig({...autoplayConfig, target: parseInt(e.target.value)})} className="w-full bg-slate-900 border border-slate-600 text-white px-4 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-yellow-500" disabled={activeStatus?.lichess?.autoplay?.enabled} />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Base Time (Secs)</label>
                            <input type="number" step="15" value={autoplayConfig.limit} onChange={(e) => setAutoplayConfig({...autoplayConfig, limit: parseInt(e.target.value)})} className="w-full bg-slate-900 border border-slate-600 text-white px-4 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-yellow-500" disabled={activeStatus?.lichess?.autoplay?.enabled} />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Increment (Secs)</label>
                            <input type="number" min="0" value={autoplayConfig.increment} onChange={(e) => setAutoplayConfig({...autoplayConfig, increment: parseInt(e.target.value)})} className="w-full bg-slate-900 border border-slate-600 text-white px-4 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-yellow-500" disabled={activeStatus?.lichess?.autoplay?.enabled} />
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Opponent Mode</label>
                            <select value={autoplayConfig.mode} onChange={(e) => setAutoplayConfig({...autoplayConfig, mode: e.target.value})} className="w-full bg-slate-900 border border-slate-600 text-white px-4 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-yellow-500" disabled={activeStatus?.lichess?.autoplay?.enabled}>
                                <option value="near">Near My Rating</option>
                                <option value="weakest">Hunt Weakest Bot</option>
                                <option value="random">Random Open</option>
                            </select>
                        </div>
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Rating Window (±)</label>
                            <input type="number" step="50" value={autoplayConfig.window} onChange={(e) => setAutoplayConfig({...autoplayConfig, window: parseInt(e.target.value)})} className="w-full bg-slate-900 border border-slate-600 text-white px-4 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-yellow-500 disabled:opacity-50" disabled={activeStatus?.lichess?.autoplay?.enabled || autoplayConfig.mode !== 'near'} />
                        </div>
                        <div className="space-y-2 flex flex-col justify-center">
                            <label className="flex items-center gap-3 cursor-pointer py-2 mt-4">
                                <input type="checkbox" checked={autoplayConfig.rated} onChange={(e) => setAutoplayConfig({...autoplayConfig, rated: e.target.checked})} className="w-5 h-5 accent-yellow-500 rounded" disabled={activeStatus?.lichess?.autoplay?.enabled} />
                                <span className="text-sm font-bold text-white">Play Rated Games</span>
                            </label>
                        </div>
                        <div className="space-y-2 lg:col-span-1">
                            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">White Opening Style</label>
                            <select value={autoplayConfig.whiteOpeningId || "balanced"} onChange={(e) => setAutoplayConfig({...autoplayConfig, whiteOpeningId: e.target.value})} className="w-full bg-slate-900 border border-slate-600 text-white px-4 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-yellow-500" disabled={activeStatus?.lichess?.autoplay?.enabled}>
                                <option value="balanced">Balanced (Global Book)</option>
                                <option value="random_tactical">Random Tactical</option>
                                <option value="random_positional">Random Positional</option>
                                {Object.entries(openings).map(([id, config]) => (
                                    <option key={id} value={id}>{config.name}</option>
                                ))}
                            </select>
                        </div>
                        <div className="space-y-2 lg:col-span-1">
                            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">Black Opening Style</label>
                            <select value={autoplayConfig.blackOpeningId || "balanced"} onChange={(e) => setAutoplayConfig({...autoplayConfig, blackOpeningId: e.target.value})} className="w-full bg-slate-900 border border-slate-600 text-white px-4 py-2.5 rounded-lg outline-none focus:ring-1 focus:ring-yellow-500" disabled={activeStatus?.lichess?.autoplay?.enabled}>
                                <option value="balanced">Balanced (Global Book)</option>
                                <option value="random_tactical">Random Tactical</option>
                                <option value="random_positional">Random Positional</option>
                                {Object.entries(openings).map(([id, config]) => (
                                    <option key={id} value={id}>{config.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    <button 
                        onClick={handleAutoplayToggle}
                        className={`w-full py-4 rounded-xl font-black text-lg transition-all shadow-lg text-white ${
                            activeStatus?.lichess?.autoplay?.enabled 
                                ? 'bg-red-600 hover:bg-red-500 border-b-4 border-red-700 active:border-b-0 active:translate-y-1' 
                                : 'bg-yellow-600 hover:bg-yellow-500 border-b-4 border-yellow-700 active:border-b-0 active:translate-y-1'
                        }`}
                    >
                        {activeStatus?.lichess?.autoplay?.enabled ? "STOP AUTOPLAY" : "START AUTOPLAY LOOP"}
                    </button>
                </div>
            </div>

            {/* Active Games Viewer */}
            <div className={`transition-opacity duration-300 ${!isRunning ? 'opacity-50' : ''}`}>
                <h2 className="text-xl font-bold text-white mb-4 border-b border-slate-800 pb-2">Active Games ({activeGames.length})</h2>
                {activeGames.length === 0 ? (
                    <div className="text-center p-12 bg-slate-900 border border-slate-800 rounded-2xl text-slate-500 font-medium">Waiting for games...</div>
                ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {activeGames.map((gameId) => (
                            <div key={gameId} className="bg-slate-900 border border-slate-800 p-5 rounded-xl flex justify-between items-center shadow-md">
                                <div className="font-mono text-slate-300 font-medium">ID: {gameId}</div>
                                <a href={`https://lichess.org/${gameId}`} target="_blank" rel="noopener noreferrer" className="bg-blue-600 hover:bg-blue-500 text-white px-5 py-2.5 rounded-lg text-sm font-bold shadow transition-colors">Watch Live ↗</a>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}