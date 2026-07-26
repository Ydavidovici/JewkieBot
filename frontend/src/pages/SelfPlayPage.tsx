import React, { useState, useEffect, useRef } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Swords, Play, ChevronLeft, ChevronRight, Activity, Cpu, History } from "lucide-react";
import { getSelfPlayVersions, runSelfPlay } from "../services/api.js";
import { useBot } from "../context/BotContext.jsx";

// Recent self-play runs, keyed per environment URL, so the live view can be
// re-opened by task id (from here or the Tasks page) after navigating away —
// and so concurrent matches are all reachable, not just the last one started.
const RUNS_KEY = "selfplay:runs";

interface StoredRun { taskId: string; url: string; v1: string; v2: string; startedAt: number; }

function loadRuns(): StoredRun[] {
    try { return JSON.parse(localStorage.getItem(RUNS_KEY) || "[]"); } catch { return []; }
}
function saveRuns(runs: StoredRun[]) {
    // Keep the list bounded; newest last.
    try { localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(-20))); } catch { /* ignore quota */ }
}
function rememberRun(run: StoredRun) {
    saveRuns([...loadRuns().filter(r => r.taskId !== run.taskId), run]);
}
function runsForUrl(url: string): StoredRun[] {
    return loadRuns().filter(r => r.url === url).sort((a, b) => b.startedAt - a.startedAt);
}

// A completed self-play game, as streamed in live (PGN) plus its decoded plies.
interface LiveGame {
    index: number;
    pgn: string;
    white: string;
    black: string;
    result: string;
    startFen: string; // position before ply 1 (book/opening position, not always standard)
    fens: string[];   // FEN after each ply (fens[0] = after ply 1)
    sans: string[];
}

function decodeGame(index: number, pgn: string): LiveGame {
    const c = new Chess();
    let white = "White", black = "Black", result = "*";
    try {
        c.loadPgn(pgn);
        const h = c.header();
        white = h.White || white;
        black = h.Black || black;
        result = h.Result || result;
    } catch (_) { /* keep partial defaults */ }

    // Verbose history carries the FEN after each move and the game's real
    // starting position. Cutechess games begin from a book position, so replaying
    // SANs from the standard start used to diverge and cut navigation short —
    // this avoids that entirely.
    const verbose = c.history({ verbose: true }) as any[];
    const sans = verbose.map(m => m.san);
    const fens = verbose.map(m => m.after);
    const startFen = verbose.length > 0 ? verbose[0].before : "start";
    return { index, pgn, white, black, result, startFen, fens, sans };
}

export default function SelfPlayPage() {
    const { activeUrl } = useBot();
    const { taskId: routeTaskId } = useParams();
    const navigate = useNavigate();
    const [runs, setRuns] = useState<StoredRun[]>([]);

    const [versions, setVersions] = useState<{version: string; label: string}[]>([]);
    const [v1, setV1] = useState("current");
    const [v2, setV2] = useState("current");
    const [games, setGames] = useState(10);
    const [tc, setTc] = useState("10+0.1");
    const [depth, setDepth] = useState("");
    const [analyze, setAnalyze] = useState(true);

    const [running, setRunning] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState({ completed: 0, total: 0 });
    const [elo, setElo] = useState<{ elo: number; error: number } | null>(null);

    const [liveGames, setLiveGames] = useState<LiveGame[]>([]);
    const [selected, setSelected] = useState<number | null>(null);
    const [ply, setPly] = useState(0);
    const esRef = useRef<EventSource | null>(null);

    // Load selectable versions (release tags + "current") for the active target.
    useEffect(() => {
        getSelfPlayVersions(activeUrl)
            .then(res => {
                const list = res?.versions ?? [];
                setVersions(list);
                // Default v2 to the newest release tag, so "current vs latest" is one click.
                const firstTag = list.find((v: any) => !v.isCurrent);
                if (firstTag) setV2(firstTag.version);
            })
            .catch(() => setVersions([{ version: "current", label: "Current build" }]));
    }, [activeUrl]);

    const stop = () => { esRef.current?.close(); esRef.current = null; };

    // Subscribe to a run's SSE stream. The backend replays the games + progress so
    // far, so this also works when re-attaching to a run already in progress (e.g.
    // after navigating away and back).
    const subscribeStream = (taskId: string) => {
        stop();
        // Reset the view for the newly-viewed run so a previous run's games don't linger.
        setError(null);
        setLiveGames([]);
        setSelected(null);
        setPly(0);
        setElo(null);
        setProgress({ completed: 0, total: 0 });
        setRunning(true);

        let gotAnyEvent = false;
        const es = new EventSource(`${activeUrl}/api/selfplay/stream/${taskId}`);
        esRef.current = es;

        es.addEventListener("progress", (e: MessageEvent) => {
            gotAnyEvent = true;
            const d = JSON.parse(e.data);
            if (d.progress) setProgress(d.progress);
            if (d.elo) setElo(d.elo);
        });
        es.addEventListener("game", (e: MessageEvent) => {
            gotAnyEvent = true;
            const d = JSON.parse(e.data);
            const decoded = decodeGame(d.index, d.pgn);
            setLiveGames(prev => {
                const next = [...prev];
                next[d.index] = decoded;
                return next;
            });
            // Auto-follow the freshest game unless the user is browsing an older one.
            setSelected(prev => (prev === null ? d.index : prev));
        });
        const finish = () => { setRunning(false); stop(); };
        es.addEventListener("done", finish);
        es.addEventListener("error", (e: MessageEvent) => {
            try { const d = JSON.parse((e as any).data); setError(d.error || "stream error"); } catch (_) {}
            finish();
        });
        // Native EventSource error (no status code available). If it fires before any
        // event arrived, the run is gone — evicted after its retention window, or the
        // backend restarted. Surface that instead of silently showing an empty board.
        es.onerror = () => {
            if (!gotAnyEvent) setError("This run is no longer available for live view (it may have finished and been cleared).");
            stop();
            setRunning(false);
        };
    };

    // Keep the sidebar's recent-runs list in sync with what's stored for this env.
    useEffect(() => { setRuns(runsForUrl(activeUrl)); }, [activeUrl, routeTaskId]);

    // Drive the viewed run from the URL. /selfplay/:taskId attaches to that run;
    // bare /selfplay re-opens the most recent run for this environment (so the
    // sidebar link and a fresh visit still restore the live board).
    useEffect(() => {
        if (routeTaskId) {
            subscribeStream(routeTaskId);
        } else {
            const recent = runsForUrl(activeUrl)[0];
            if (recent) navigate(`/selfplay/${recent.taskId}`, { replace: true });
        }
        return () => esRef.current?.close();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeUrl, routeTaskId]);

    const start = async () => {
        stop();
        setError(null);
        setLiveGames([]);
        setSelected(null);
        setPly(0);
        setElo(null);
        setProgress({ completed: 0, total: Number(games) });
        setRunning(true);

        try {
            const res = await runSelfPlay({
                v1, v2,
                games: Number(games),
                tc,
                depth: depth ? Number(depth) : undefined,
                analyze,
            }, activeUrl);

            const taskId = res?.taskId;
            if (!taskId) throw new Error("No taskId returned");

            rememberRun({ taskId, url: activeUrl, v1, v2, startedAt: Date.now() });
            setRuns(runsForUrl(activeUrl));
            // Give this run its own URL; the route effect subscribes to it. If we're
            // already on that URL (unlikely — ids are unique), subscribe directly.
            if (routeTaskId === taskId) subscribeStream(taskId);
            else navigate(`/selfplay/${taskId}`);
        } catch (err: any) {
            setError(err?.response?.data?.error || err.message);
            setRunning(false);
        }
    };

    const current = selected !== null ? liveGames[selected] : null;
    const boardFen = !current ? "start" : ply === 0 ? current.startFen : (current.fens[ply - 1] || current.startFen);
    const maxPly = current ? current.fens.length : 0;

    const score = (() => {
        // Wins for v1 across decoded games. Games stream in completion order, not
        // round order (cutechess runs them concurrently), so derive v1's colour
        // from the PGN's White header rather than the game index.
        const v1Name = `Jewkiebot-${v1}`;
        let w = 0, l = 0, d = 0;
        liveGames.forEach((g) => {
            if (!g) return;
            const v1IsWhite = g.white === v1Name;
            if (g.result === "1/2-1/2") d++;
            else if (g.result === "1-0") (v1IsWhite ? w++ : l++);
            else if (g.result === "0-1") (v1IsWhite ? l++ : w++);
        });
        return { w, l, d };
    })();

    return (
        <div className="space-y-6 animate-in fade-in duration-500 h-[calc(100vh-8rem)] flex flex-col">
            <header className="flex justify-between items-center shrink-0">
                <div>
                    <h1 className="text-3xl font-black text-white mb-2 tracking-tight flex items-center gap-3">
                        <Swords className="text-purple-400" /> Self-Play
                    </h1>
                    <p className="text-slate-400">Run a version head-to-head on the remote host and watch the games stream in live.</p>
                </div>
            </header>

            <div className="flex-1 flex gap-8 min-h-0">
                {/* Left: config + games list */}
                <div className="w-72 flex flex-col gap-4 shrink-0">
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-lg p-4 flex flex-col gap-3">
                        <h2 className="font-bold text-white flex items-center gap-2"><Cpu size={18} className="text-purple-400" /> Match Setup</h2>

                        <label className="text-xs text-slate-400 font-semibold">Engine A (White first)</label>
                        <select value={v1} onChange={e => setV1(e.target.value)} disabled={running}
                            className="bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg focus:outline-none focus:border-purple-500">
                            {versions.map(v => <option key={v.version} value={v.version}>{v.label}</option>)}
                        </select>

                        <label className="text-xs text-slate-400 font-semibold">Engine B</label>
                        <select value={v2} onChange={e => setV2(e.target.value)} disabled={running}
                            className="bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg focus:outline-none focus:border-purple-500">
                            {versions.map(v => <option key={v.version} value={v.version}>{v.label}</option>)}
                        </select>

                        <div className="grid grid-cols-2 gap-2">
                            <div>
                                <label className="text-xs text-slate-400 font-semibold">Games</label>
                                <input type="number" min={2} step={2} value={games} onChange={e => setGames(Number(e.target.value))} disabled={running}
                                    className="bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg w-full focus:outline-none focus:border-purple-500" />
                            </div>
                            <div>
                                <label className="text-xs text-slate-400 font-semibold">Time control</label>
                                <input type="text" value={tc} onChange={e => setTc(e.target.value)} disabled={running}
                                    className="bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg w-full focus:outline-none focus:border-purple-500" />
                            </div>
                        </div>

                        <div>
                            <label className="text-xs text-slate-400 font-semibold">Fixed depth (optional)</label>
                            <input type="number" min={1} value={depth} onChange={e => setDepth(e.target.value)} disabled={running} placeholder="—"
                                className="bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg w-full focus:outline-none focus:border-purple-500" />
                        </div>

                        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                            <input type="checkbox" checked={analyze} onChange={e => setAnalyze(e.target.checked)} disabled={running} />
                            Analyze games after (Stockfish + jewkiebot)
                        </label>

                        <button onClick={start} disabled={running}
                            className="mt-1 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-colors">
                            <Play size={16} fill="currentColor" /> {running ? "Running…" : "Run Match"}
                        </button>

                        {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>}
                    </div>

                    {/* Recent runs — switch between concurrent / past matches for this env */}
                    {runs.length > 0 && (
                        <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-lg overflow-hidden shrink-0">
                            <div className="p-3 border-b border-slate-800 flex items-center gap-2">
                                <History size={16} className="text-purple-400" />
                                <h2 className="font-bold text-white text-sm">Recent Runs</h2>
                            </div>
                            <div className="max-h-40 overflow-auto p-2 flex flex-col gap-1">
                                {runs.map(r => (
                                    <Link key={r.taskId} to={`/selfplay/${r.taskId}`}
                                        className={`block p-2 rounded-lg text-xs transition-colors ${r.taskId === routeTaskId ? "bg-purple-600/20 border border-purple-500/30 text-white" : "hover:bg-slate-800 border border-transparent text-slate-300"}`}>
                                        <div className="flex justify-between gap-2">
                                            <span className="truncate font-mono">{r.v1} vs {r.v2}</span>
                                            <span className="text-slate-500 shrink-0">{new Date(r.startedAt).toLocaleTimeString()}</span>
                                        </div>
                                    </Link>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Games list */}
                    <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl shadow-lg flex flex-col overflow-hidden min-h-0">
                        <div className="p-3 border-b border-slate-800 flex items-center justify-between">
                            <h2 className="font-bold text-white text-sm flex items-center gap-2"><Activity size={16} className="text-purple-400" /> Games</h2>
                            <span className="text-xs text-slate-400 font-mono">{progress.completed}/{progress.total}</span>
                        </div>
                        <div className="flex-1 overflow-auto p-2 flex flex-col gap-1">
                            {liveGames.map((g, i) => g && (
                                <button key={i} onClick={() => { setSelected(i); setPly(g.fens.length); }}
                                    className={`text-left p-2 rounded-lg text-xs transition-colors ${selected === i ? "bg-purple-600/20 border border-purple-500/30" : "hover:bg-slate-800 border border-transparent"}`}>
                                    <div className="flex justify-between text-slate-200">
                                        <span className="truncate">#{i + 1} {g.white} vs {g.black}</span>
                                        <span className="font-mono text-slate-400">{g.result}</span>
                                    </div>
                                </button>
                            ))}
                            {liveGames.length === 0 && <p className="text-center italic mt-4 text-slate-500 text-xs">No games yet.</p>}
                        </div>
                    </div>
                </div>

                {/* Center: board */}
                <div className="w-[600px] flex flex-col gap-4 shrink-0">
                    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl">
                        <Chessboard position={boardFen} animationDuration={150}
                            customBoardStyle={{ borderRadius: "8px", boxShadow: "0 10px 25px rgba(0,0,0,0.5)" }} />
                    </div>
                    <div className="flex items-center justify-center gap-4 bg-slate-900 border border-slate-800 rounded-xl p-3 shadow-lg">
                        <button onClick={() => setPly(p => Math.max(0, p - 1))} disabled={!current}
                            className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white disabled:opacity-30"><ChevronLeft size={24} /></button>
                        <span className="font-mono text-slate-300 w-16 text-center">{ply} / {maxPly}</span>
                        <button onClick={() => setPly(p => Math.min(maxPly, p + 1))} disabled={!current}
                            className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white disabled:opacity-30"><ChevronRight size={24} /></button>
                    </div>
                </div>

                {/* Right: scoreboard + moves */}
                <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl shadow-lg flex flex-col overflow-hidden min-w-0">
                    <div className="p-4 border-b border-slate-800">
                        <h2 className="font-bold text-white">Result — Engine A ({v1})</h2>
                        <div className="mt-2 flex gap-3 text-sm font-mono">
                            <span className="text-green-400">+{score.w}W</span>
                            <span className="text-red-400">−{score.l}L</span>
                            <span className="text-slate-400">={score.d}D</span>
                            {elo && <span className="ml-auto text-purple-300">Elo {elo.elo > 0 ? "+" : ""}{elo.elo.toFixed(0)} ±{Number.isFinite(elo.error) ? elo.error.toFixed(0) : "?"}</span>}
                        </div>
                    </div>
                    <div className="flex-1 p-4 overflow-auto">
                        <h3 className="text-xs font-bold tracking-widest text-slate-500 uppercase mb-3">Moves</h3>
                        <div className="flex flex-wrap gap-1">
                            {current?.sans.map((san, i) => (
                                <span key={i} onClick={() => setPly(i + 1)}
                                    className={`cursor-pointer px-1.5 py-0.5 rounded text-sm font-mono transition-colors ${i + 1 === ply ? "bg-purple-600 text-white" : "text-slate-400 hover:text-slate-200 hover:bg-slate-800"}`}>
                                    {i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ` : ""}{san}
                                </span>
                            ))}
                            {!current && <p className="text-slate-500 italic text-sm">Select a game to replay it.</p>}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
