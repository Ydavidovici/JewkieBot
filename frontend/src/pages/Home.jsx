import React, { useState } from "react";
import { useBot } from "../context/BotContext.jsx";
import { health, getLichessStatus, analyze, runBenchmark, startLichessBot, stopLichessBot } from "../services/api.js";
import { Server, Activity, Terminal, Play, Square, Search, Zap } from "lucide-react";

export default function Home() {
    const { botTarget, activeUrl, activeStatus, refreshActive } = useBot();
    const [commandOutput, setCommandOutput] = useState("");
    const [loadingCommand, setLoadingCommand] = useState(false);

    const executeCommand = async (name, fn) => {
        setLoadingCommand(true);
        setCommandOutput(`Executing /${name} on ${botTarget.toUpperCase()}...`);
        try {
            const data = await fn();
            setCommandOutput(`[Success] /${name}\n\n${JSON.stringify(data, null, 2)}`);
        } catch (err) {
            setCommandOutput(`[Error] /${name}\n\n${err.message}`);
        } finally {
            setLoadingCommand(false);
            refreshActive();
        }
    };

    const cmdHealth = () => executeCommand("health", () => health(activeUrl));
    const cmdStatus = () => executeCommand("status", () => getLichessStatus(activeUrl));
    const cmdAnalysis = () => executeCommand("analysis", () => analyze("startpos", 10, activeUrl));
    const cmdBench = () => executeCommand("bench", () => runBenchmark({ mode: "depth", depth: 7 }, activeUrl));

    const handleLichessToggle = async () => {
        if (activeStatus?.lichess?.running) {
            await executeCommand("stop_lichess", () => stopLichessBot(activeUrl));
        } else {
            await executeCommand("start_lichess", () => startLichessBot(undefined, activeUrl));
        }
    };

    return (
        <div className="space-y-8 animate-in fade-in duration-500">
            <header>
                <h1 className="text-3xl font-black text-white mb-2 tracking-tight">Dashboard Hub</h1>
                <p className="text-slate-400">Overview of the selected environment and quick actions.</p>
            </header>

            {/* Status Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg flex items-center gap-5 transition-transform hover:scale-[1.02]">
                    <div className={`p-4 rounded-xl ${activeStatus?.health ? 'bg-green-500/20 text-green-400 shadow-[0_0_15px_rgba(34,197,94,0.2)]' : 'bg-red-500/20 text-red-500 shadow-[0_0_15px_rgba(239,68,68,0.2)]'}`}>
                        <Server size={24} />
                    </div>
                    <div>
                        <p className="text-sm font-medium text-slate-400">Backend Status</p>
                        <p className="text-xl font-bold text-white">{activeStatus?.health ? 'Online' : 'Offline'}</p>
                    </div>
                </div>
                
                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg flex items-center gap-5 transition-transform hover:scale-[1.02]">
                    <div className="p-4 rounded-xl bg-blue-500/20 text-blue-400 shadow-[0_0_15px_rgba(59,130,246,0.2)]">
                        <Activity size={24} />
                    </div>
                    <div>
                        <p className="text-sm font-medium text-slate-400">Active Engines</p>
                        <p className="text-xl font-bold text-white">{activeStatus?.health?.engineCount ?? 0}</p>
                    </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg flex items-center gap-5 transition-transform hover:scale-[1.02]">
                    <div className={`p-4 rounded-xl ${activeStatus?.lichess?.running ? 'bg-purple-500/20 text-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.2)]' : 'bg-slate-800 text-slate-500'}`}>
                        <Play size={24} />
                    </div>
                    <div>
                        <p className="text-sm font-medium text-slate-400">Lichess Bot</p>
                        <p className="text-xl font-bold text-white">{activeStatus?.lichess?.running ? 'Running' : 'Stopped'}</p>
                    </div>
                </div>

                <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-lg flex items-center gap-5 transition-transform hover:scale-[1.02]">
                    <div className="p-4 rounded-xl bg-orange-500/20 text-orange-400 shadow-[0_0_15px_rgba(249,115,22,0.2)]">
                        <Zap size={24} />
                    </div>
                    <div>
                        <p className="text-sm font-medium text-slate-400">Active Games</p>
                        <p className="text-xl font-bold text-white">{activeStatus?.lichess?.activeGames?.length ?? 0}</p>
                    </div>
                </div>
            </div>

            {/* Quick Actions (Discord Commands) */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">
                <div className="p-6 border-b border-slate-800 bg-slate-900/50 flex justify-between items-center">
                    <h2 className="text-xl font-bold text-white flex items-center gap-3">
                        <Terminal size={20} className="text-blue-400" /> Discord Command Runner
                    </h2>
                </div>
                
                <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <button onClick={cmdHealth} disabled={loadingCommand} className="flex items-center justify-center gap-3 py-3.5 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl border border-slate-700 transition-colors font-semibold shadow-sm">
                        <Activity size={18} className="text-green-400" /> /health
                    </button>
                    <button onClick={cmdStatus} disabled={loadingCommand} className="flex items-center justify-center gap-3 py-3.5 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl border border-slate-700 transition-colors font-semibold shadow-sm">
                        <Server size={18} className="text-blue-400" /> /status
                    </button>
                    <button onClick={cmdAnalysis} disabled={loadingCommand} className="flex items-center justify-center gap-3 py-3.5 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl border border-slate-700 transition-colors font-semibold shadow-sm">
                        <Search size={18} className="text-purple-400" /> /analysis
                    </button>
                    <button onClick={cmdBench} disabled={loadingCommand} className="flex items-center justify-center gap-3 py-3.5 px-4 bg-slate-800 hover:bg-slate-700 text-white rounded-xl border border-slate-700 transition-colors font-semibold shadow-sm">
                        <Zap size={18} className="text-yellow-400" /> /bench
                    </button>
                </div>

                {/* Quick Lichess Start/Stop */}
                <div className="px-6 pb-6 pt-4">
                    <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-4">Lichess Fast Actions</h3>
                    <button 
                        onClick={handleLichessToggle} 
                        disabled={loadingCommand}
                        className={`flex items-center justify-center gap-2 py-3 px-8 rounded-xl font-bold transition-all shadow-lg text-white w-full md:w-auto ${
                            activeStatus?.lichess?.running 
                                ? 'bg-red-600 hover:bg-red-500 border-b-4 border-red-700 active:border-b-0 active:translate-y-1' 
                                : 'bg-green-600 hover:bg-green-500 border-b-4 border-green-700 active:border-b-0 active:translate-y-1'
                        }`}
                    >
                        {activeStatus?.lichess?.running ? (
                            <><Square size={18} fill="currentColor" /> Stop Lichess Bot</>
                        ) : (
                            <><Play size={18} fill="currentColor" /> Start Lichess Bot</>
                        )}
                    </button>
                </div>

                {/* Command Output Terminal */}
                {commandOutput && (
                    <div className="p-6 bg-[#0c0c0c] border-t border-slate-800">
                        <div className="flex items-center gap-2 mb-4">
                            <div className="w-3 h-3 rounded-full bg-red-500/80" />
                            <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
                            <div className="w-3 h-3 rounded-full bg-green-500/80" />
                            <span className="text-xs text-slate-600 ml-2 font-mono uppercase tracking-widest">Console Output</span>
                        </div>
                        <pre className="font-mono text-sm text-green-400/90 overflow-x-auto whitespace-pre-wrap">
                            {commandOutput}
                        </pre>
                    </div>
                )}
            </div>
        </div>
    );
}
