import React, { useState } from "react";
import { runBenchmark, cancelBenchmark } from "../services/api.js";
import { useBot } from "../context/BotContext.jsx";
import { Activity, XCircle, Zap, Cpu, Search } from "lucide-react";

const ResultCard = ({ label, value, sub, color = "text-white" }) => (
    <div className="bg-slate-800 p-6 rounded-2xl text-center shadow-lg border border-slate-700 hover:border-slate-600 transition-colors">
        <div className="text-slate-400 text-xs font-bold uppercase tracking-wider mb-2 flex items-center justify-center gap-2">
            {label}
        </div>
        <div className={`text-3xl font-black ${color} tracking-tight`}>{value}</div>
        {sub && <div className="text-xs text-slate-500 mt-2 font-medium">{sub}</div>}
    </div>
);

export default function BenchmarkControl() {
    const { activeUrl } = useBot();
    const [mode, setMode] = useState("time");
    const [paramValue, setParamValue] = useState(5);
    const [evalTime, setEvalTime] = useState(1);

    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState(null);
    const [error, setError] = useState(null);

    const calculateTotalTime = () => {
        const POSITION_COUNT = 3;
        let searchDuration = 0;

        if (mode === "time") {
            searchDuration = paramValue * POSITION_COUNT;
        } else {
            searchDuration = (paramValue > 8 ? 10 : 2) * POSITION_COUNT;
        }

        return searchDuration + evalTime;
    };

    const totalDuration = calculateTotalTime();

    const handleRun = async () => {
        setLoading(true);
        setError(null);
        setResults(null);

        const payload = {
            mode: mode,
            evalTime: evalTime * 1000,
            ...(mode === "time" ? { timeLimit: paramValue * 1000 } : { depth: paramValue })
        };

        try {
            const response = await runBenchmark(payload, activeUrl);

            if (response.status === "cancelled") {
                setError("Benchmark cancelled by user.");
                return;
            }

            setResults(response.data);
        } catch (err) {
            if (err.message !== "Cancelled by user") {
                setError(err.message || "Benchmark failed");
            }
        } finally {
            setLoading(false);
        }
    };

    const handleCancel = async () => {
        try {
            await cancelBenchmark(activeUrl);
            setError("Cancelling...");
        } catch (err) {
            console.error("Failed to cancel:", err);
        }
    };

    return (
        <div className="animate-in fade-in duration-500 max-w-4xl mx-auto space-y-8">
            <header>
                <h1 className="text-3xl font-black text-white mb-2 tracking-tight">Diagnostics & Benchmarks</h1>
                <p className="text-slate-400">Run performance benchmarks against the active backend engine.</p>
            </header>

            <div className="p-8 bg-slate-900 rounded-2xl border border-slate-800 shadow-2xl">
                <h2 className="text-xl font-bold mb-8 flex items-center gap-3 text-white">
                    <Activity size={24} className="text-purple-400" /> Custom Benchmark Suite
                </h2>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
                    <div className="space-y-3">
                        <label className="text-sm font-semibold text-slate-300">Search Target</label>
                        <div className="flex bg-slate-950 rounded-xl p-1.5 border border-slate-800 shadow-inner">
                            <button
                                onClick={() => setMode("time")}
                                className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-all ${mode === "time" ? "bg-blue-600 text-white shadow-md" : "text-slate-400 hover:text-white"
                                }`}
                            >
                                Fixed Time
                            </button>
                            <button
                                onClick={() => setMode("depth")}
                                className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-all ${mode === "depth" ? "bg-purple-600 text-white shadow-md" : "text-slate-400 hover:text-white"
                                }`}
                            >
                                Fixed Depth
                            </button>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <label className="text-sm font-semibold text-slate-300">
                            {mode === "time" ? "Search Time per Position (Seconds)" : "Search Target Depth (Ply)"}
                        </label>
                        <input
                            type="number"
                            min="1"
                            max={mode === "depth" ? 20 : 60}
                            value={paramValue}
                            onChange={(e) => setParamValue(parseInt(e.target.value) || 1)}
                            className="w-full bg-slate-950 border border-slate-700 text-white p-3 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all shadow-inner"
                        />
                        <p className="text-xs text-slate-500 font-medium mt-1">
                            {mode === "time"
                                ? "Engine will search as deep as possible within this time limit."
                                : "Engine will search until it reaches this exact depth."}
                        </p>
                    </div>

                    <div className="space-y-3 md:col-span-2 border-t border-slate-800 pt-6 mt-2">
                        <div className="flex justify-between items-center mb-2">
                            <label className="text-sm font-semibold text-slate-300">Static Eval Test Duration</label>
                            <span className="bg-slate-800 px-4 py-1.5 rounded-lg text-sm font-bold text-white border border-slate-700">
                                {evalTime}s
                            </span>
                        </div>
                        <div className="flex items-center gap-4">
                            <input
                                type="range"
                                min="0"
                                max="5"
                                step="0.5"
                                value={evalTime}
                                onChange={(e) => setEvalTime(parseFloat(e.target.value))}
                                className="flex-1 h-2.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-green-500"
                            />
                        </div>
                        <p className="text-xs text-slate-500 font-medium">
                            Measures raw EPS (Evals Per Second). Does not perform any search.
                        </p>
                    </div>
                </div>

                <div className="bg-slate-950 rounded-xl p-4 mb-8 flex justify-between items-center border border-slate-800 shadow-inner">
                    <span className="text-sm font-medium text-slate-400">Estimated Total Runtime:</span>
                    <span className="font-mono text-xl font-bold text-yellow-400">
                        ~{totalDuration}s
                    </span>
                </div>

                {!loading ? (
                    <button
                        onClick={handleRun}
                        className="w-full py-4 rounded-xl font-black text-lg transition-all shadow-[0_0_20px_rgba(59,130,246,0.3)] bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white transform hover:scale-[1.01]"
                    >
                        START BENCHMARK
                    </button>
                ) : (
                    <button
                        onClick={handleCancel}
                        className="w-full py-4 rounded-xl font-black text-lg transition-all shadow-lg bg-red-600 hover:bg-red-500 text-white animate-pulse"
                    >
                        <div className="flex items-center justify-center gap-3">
                            <div className="w-5 h-5 border-4 border-white/30 border-t-white rounded-full animate-spin" />
                            <span>RUNNING... (CLICK TO CANCEL)</span>
                        </div>
                    </button>
                )}

                {error && (
                    <div className="mt-8 p-4 bg-red-950/50 border border-red-500/50 rounded-xl text-red-200 text-center font-medium flex items-center justify-center gap-2">
                        <XCircle size={18} /> {error}
                    </div>
                )}

                {results && !loading && (
                    <div className="mt-10 space-y-8 animate-in slide-in-from-bottom-4 duration-500">
                        <div className="h-px bg-slate-800" />

                        <div className="grid grid-cols-2 gap-6">
                            <ResultCard
                                label={<><Search size={16}/> NPS (Speed)</>}
                                value={results.nps.toLocaleString()}
                                sub="Nodes / Second"
                                color="text-blue-400"
                            />
                            <ResultCard
                                label={<><Cpu size={16}/> EPS (Throughput)</>}
                                value={results.eps.toLocaleString()}
                                sub="Evals / Second"
                                color="text-green-400"
                            />
                        </div>

                        <div className="bg-slate-950 p-8 rounded-2xl border border-slate-800 shadow-inner">
                            <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-8 text-center">
                                Search Efficiency Breakdown
                            </h3>
                            <div className="grid grid-cols-3 gap-6 text-center">
                                <div className="flex flex-col items-center">
                                    <div className="text-4xl font-black text-yellow-500 mb-2">{results.ordering}%</div>
                                    <div className="text-xs font-bold text-slate-400 uppercase">Move Ordering</div>
                                    <div className="text-[10px] text-slate-600 mt-1 font-medium">Goal: &gt;85%</div>
                                </div>
                                <div className="flex flex-col items-center border-l border-slate-800">
                                    <div className="text-4xl font-black text-purple-400 mb-2">{results.qSearch}%</div>
                                    <div className="text-xs font-bold text-slate-400 uppercase">Q-Search Load</div>
                                    <div className="text-[10px] text-slate-600 mt-1 font-medium">Goal: &lt;50%</div>
                                </div>
                                <div className="flex flex-col items-center border-l border-slate-800">
                                    <div className="text-4xl font-black text-pink-400 mb-2">{results.ttHit}%</div>
                                    <div className="text-xs font-bold text-slate-400 uppercase">TT Hit Rate</div>
                                    <div className="text-[10px] text-slate-600 mt-1 font-medium">Higher is better</div>
                                </div>
                            </div>
                        </div>

                        <div className="text-center mt-6">
                            <span className="inline-block bg-slate-800 px-4 py-2 rounded-lg text-xs font-bold text-slate-400 border border-slate-700 shadow-sm">
                                Processed {results.nodes.toLocaleString()} nodes in {results.time}s
                            </span>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}