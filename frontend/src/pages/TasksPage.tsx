import React, {useState, useEffect} from "react";
import {useNavigate} from "react-router-dom";
import {Activity, Download, HardDrive, ListOrdered, FileText} from "lucide-react";

interface TaskRow {
    id: string;
    type: string;
    status: string;
    progress?: any;
    result?: any;
}

export default function TasksPage() {
    const navigate = useNavigate();
    const [tasks, setTasks] = useState<TaskRow[]>([]);

    // Chess.com State
    const [username, setUsername] = useState("");
    const [months, setMonths] = useState(1);

    // PGN State
    const [pgnString, setPgnString] = useState("");

    // Tournament State
    const [tourneyGames, setTourneyGames] = useState(100);
    const [tourneyOpponent, setTourneyOpponent] = useState("stockfish");
    const [tourneySfDepth, setTourneySfDepth] = useState(4);

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const fetchTasks = async () => {
        try {
            const res = await fetch("/api/tasks");
            const data = await res.json();
            setTasks(data);
        } catch (e) {
            console.error("Failed to fetch tasks", e);
        }
    };

    useEffect(() => {
        fetchTasks();
        const interval = setInterval(fetchTasks, 2000);
        return () => clearInterval(interval);
    }, []);

    const handleChessComFetch = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/chesscom/fetch", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({username, months}),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to fetch games");
            setUsername("");
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
            fetchTasks();
        }
    };

    const handlePgnIngest = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await fetch("/api/pgn/ingest", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({pgn: pgnString}),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to ingest PGN");
            setPgnString("");
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
            fetchTasks();
        }
    };

    return (
        <div className="flex flex-col h-full bg-slate-950 text-slate-100 p-8 overflow-y-auto">
            <h1 className="text-3xl font-black mb-8 text-white flex items-center gap-3">
                <ListOrdered className="text-blue-500"/> Tasks & Integrations
            </h1>

            {error && (
                <div className="mb-6 bg-red-900/50 border border-red-500/50 text-red-200 px-4 py-3 rounded">
                    <span className="font-semibold">Error: </span> {error}
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
                {/* Importers */}
                <div className="space-y-6">
                    <div className="bg-slate-900 rounded-lg p-6 border border-slate-800 shadow-xl">
                        <h2 className="text-xl font-semibold mb-4 text-emerald-400 flex items-center gap-2">
                            <Download size={20}/> Chess.com Importer
                        </h2>
                        <form onSubmit={handleChessComFetch} className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Username</label>
                                <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. Hikaru" className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors" required/>
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Months back to fetch</label>
                                <input type="number" min="1" max="12" value={months} onChange={(e) => setMonths(parseInt(e.target.value))} className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-emerald-500 transition-colors" required/>
                            </div>
                            <button type="submit" disabled={loading || !username} className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded font-medium transition-colors">
                                Import Games
                            </button>
                        </form>
                    </div>

                    <div className="bg-slate-900 rounded-lg p-6 border border-slate-800 shadow-xl">
                        <h2 className="text-xl font-semibold mb-4 text-amber-400 flex items-center gap-2">
                            <FileText size={20}/> PGN String Ingestion
                        </h2>
                        <form onSubmit={handlePgnIngest} className="space-y-4">
                            <div>
                                <textarea value={pgnString} onChange={(e) => setPgnString(e.target.value)} placeholder="[Event ...] \n1. e4 e5..." className="w-full h-32 bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white text-sm font-mono focus:outline-none focus:border-amber-500 transition-colors" required/>
                            </div>
                            <button type="submit" disabled={loading || !pgnString} className="w-full py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded font-medium transition-colors">
                                Parse & Ingest PGN
                            </button>
                        </form>
                    </div>

                    <div className="bg-slate-900 rounded-lg p-6 border border-slate-800 shadow-xl">
                        <h2 className="text-xl font-semibold mb-4 text-rose-400 flex items-center gap-2">
                            <Activity size={20}/> Cutechess Tournament
                        </h2>
                        <p className="text-sm text-slate-400 mb-4">Run a Gauntlet or Self-Play match in the background.</p>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Opponent</label>
                                <select 
                                    value={tourneyOpponent} 
                                    onChange={(e) => setTourneyOpponent(e.target.value)}
                                    className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-rose-500 transition-colors"
                                >
                                    <option value="stockfish">Stockfish</option>
                                    <option value="self">Self-Play (JewkieBot)</option>
                                </select>
                            </div>

                            {tourneyOpponent === "stockfish" && (
                                <div>
                                    <label className="block text-sm font-medium text-slate-300 mb-1">Stockfish Depth</label>
                                    <select 
                                        value={tourneySfDepth} 
                                        onChange={(e) => setTourneySfDepth(parseInt(e.target.value))}
                                        className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-rose-500 transition-colors"
                                    >
                                        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20].map(depth => (
                                            <option key={depth} value={depth}>Depth {depth}</option>
                                        ))}
                                    </select>
                                </div>
                            )}

                            <div>
                                <label className="block text-sm font-medium text-slate-300 mb-1">Number of Games</label>
                                <select 
                                    value={tourneyGames} 
                                    onChange={(e) => setTourneyGames(parseInt(e.target.value))}
                                    className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white focus:outline-none focus:border-rose-500 transition-colors"
                                >
                                    {[10, 50, 100, 200, 500, 1000].map(games => (
                                        <option key={games} value={games}>{games} Games</option>
                                    ))}
                                </select>
                            </div>

                            <button
                                onClick={async () => {
                                    setLoading(true);
                                    if (tourneyOpponent === "self") {
                                        await fetch("/api/selfplay/run", {
                                            method: "POST",
                                            headers: {"Content-Type": "application/json"},
                                            body: JSON.stringify({
                                                v1: "current", v2: "current", tc: "10+0.1", games: tourneyGames,
                                            }),
                                        });
                                    } else {
                                        await fetch("/api/cutechess/gauntlet", {
                                            method: "POST",
                                            headers: {"Content-Type": "application/json"},
                                            body: JSON.stringify({
                                                myEngine: {name: "JewkieBot", path: "jewkiebot/build/jewkiebot.exe"},
                                                opponents: [
                                                    {name: `SF-Depth${tourneySfDepth}`, path: "stockfish/stockfish", args: [`depth=${tourneySfDepth}`]}
                                                ],
                                                tc: "10+0.1",
                                                games: tourneyGames,
                                            }),
                                        });
                                    }
                                    setLoading(false);
                                    fetchTasks();
                                }}
                                disabled={loading}
                                className="w-full py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded font-medium transition-colors text-sm"
                            >
                                Start {tourneyOpponent === "self" ? "Self-Play" : "Gauntlet"} Match
                            </button>
                        </div>
                    </div>
                </div>

                {/* System & Background Tasks */}
                <div className="space-y-6">
                    <div className="bg-slate-900 rounded-lg p-6 border border-slate-800 shadow-xl">
                        <h2 className="text-xl font-semibold mb-4 text-cyan-400 flex items-center gap-2">
                            <HardDrive size={20}/> Core Systems
                        </h2>
                        <div className="flex gap-4">
                            <button
                                onClick={async () => {
                                    setLoading(true);
                                    await fetch("/api/analysis/run", {method: "POST", credentials: "include", headers: {"Content-Type": "application/json"}, body: JSON.stringify({})});
                                    setLoading(false);
                                    fetchTasks();
                                }}
                                disabled={loading}
                                className="flex-1 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded font-medium transition-colors text-sm"
                            >
                                Run Teacher Analysis
                            </button>
                            <button
                                onClick={async () => {
                                    setLoading(true);
                                    await fetch("/api/engine/build", {method: "POST"});
                                    setLoading(false);
                                    fetchTasks();
                                }}
                                disabled={loading}
                                className="flex-1 py-2 bg-slate-700 hover:bg-slate-600 border border-slate-600 disabled:opacity-50 text-white rounded font-medium transition-colors text-sm"
                            >
                                Recompile JewkieBot C++
                            </button>
                        </div>
                    </div>

                    <div className="bg-slate-900 rounded-lg p-6 border border-slate-800 shadow-xl flex flex-col h-[500px]">
                        <h2 className="text-xl font-semibold mb-4 text-purple-400 flex items-center gap-2">
                            <Activity size={20}/> Background Tasks
                        </h2>

                        <div className="flex-1 overflow-y-auto space-y-3">
                            {tasks.length === 0 ? (
                                <p className="text-slate-500 text-sm text-center py-8">No tasks running.</p>
                            ) : (
                                tasks.map(task => {
                                    // Self-play runs have a live/replay view addressable by task id.
                                    const viewable = task.type === "selfplay";
                                    return (
                                    <div key={task.id}
                                        onClick={viewable ? () => navigate(`/selfplay/${task.id}`) : undefined}
                                        className={`p-4 rounded-lg bg-slate-950 border border-slate-800 flex flex-col gap-2 ${viewable ? "cursor-pointer hover:border-purple-500/50 transition-colors" : ""}`}>
                                        <div className="flex justify-between items-center">
                                            <span className="font-semibold text-slate-200 capitalize">
                                                {task.type.replace("_", " ")}
                                                {viewable && <span className="ml-2 text-xs font-normal text-purple-400">View →</span>}
                                            </span>
                                            <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                                                task.status === "COMPLETED" ? "bg-emerald-500/20 text-emerald-400" :
                                                    task.status === "RUNNING" ? "bg-blue-500/20 text-blue-400" :
                                                        "bg-red-500/20 text-red-400"
                                            }`}>
                                                {task.status}
                                            </span>
                                        </div>
                                        <p className="text-xs text-slate-500">{task.id}</p>
                                        {task.progress && (
                                            <div className="text-xs text-slate-400 bg-slate-900 p-2 rounded">
                                                {typeof task.progress === "string" ? task.progress : JSON.stringify(task.progress)}
                                            </div>
                                        )}
                                        {task.result && (
                                            <div className="text-xs text-slate-400 bg-slate-900 p-2 rounded break-words max-h-32 overflow-y-auto">
                                                Result: {JSON.stringify(task.result)}
                                            </div>
                                        )}
                                    </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
