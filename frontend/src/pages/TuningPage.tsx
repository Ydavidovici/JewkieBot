import React, { useState, useEffect, useRef } from "react";
import { SlidersHorizontal, Check, RotateCcw, Download, Upload, Play, Square, Server } from "lucide-react";
import {
    getTuningParams, applyTuningParams, clearTuningParams,
    runServerTuning, getServerTuningStatus, stopServerTuning,
} from "../services/api.js";
import { useBot } from "../context/BotContext.jsx";

// Applies the results of an external Texel tuning run: paste/upload the tuned
// parameter vector, and the engine loads it (persisted server-side, sent on
// every engine spawn). The engine's own current values seed the editor.
export default function TuningPage() {
    const { activeUrl } = useBot();

    const [count, setCount] = useState<number | null>(null);
    const [applied, setApplied] = useState(false);
    const [text, setText] = useState("");
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    // Server-driven tuning run
    const [games, setGames] = useState(200);
    const [maxEpochs, setMaxEpochs] = useState(50);
    const [runStatus, setRunStatus] = useState<any>(null);
    const pollRef = useRef<any>(null);

    const load = async () => {
        setLoading(true);
        setError(null);
        try {
            const d: any = await getTuningParams(activeUrl);
            setCount(d?.count ?? null);
            setApplied(!!d?.applied);
            if (Array.isArray(d?.params) && d.params.length) {
                setText(d.params.join("\n"));
            }
        } catch (err: any) {
            setError(err?.response?.data?.error || err.message || "Failed to load params");
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [activeUrl]);

    // Poll the server-tuning status. Starts on mount (to re-attach to a run in
    // progress) and keeps polling while a run is active; on completion it reloads
    // the applied params into the editor.
    useEffect(() => {
        const tick = async () => {
            try {
                const s: any = await getServerTuningStatus(activeUrl);
                setRunStatus(s);
                if (s?.running) {
                    if (!pollRef.current) pollRef.current = setInterval(tick, 2000);
                } else {
                    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
                    if (s?.phase === "done") load();  // pull the newly applied params in
                }
            } catch (_) { /* leave status as-is */ }
        };
        tick();
        return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeUrl]);

    const startRun = async () => {
        setError(null);
        setNotice(null);
        try {
            await runServerTuning({ games: Number(games), maxEpochs: Number(maxEpochs) }, activeUrl);
            const s: any = await getServerTuningStatus(activeUrl);
            setRunStatus(s);
            if (!pollRef.current) pollRef.current = setInterval(async () => {
                const st: any = await getServerTuningStatus(activeUrl).catch(() => null);
                if (st) setRunStatus(st);
                if (st && !st.running) { clearInterval(pollRef.current); pollRef.current = null; if (st.phase === "done") load(); }
            }, 2000);
        } catch (err: any) {
            setError(err?.response?.data?.error || err.message || "Failed to start tuning");
        }
    };

    const stopServer = async () => {
        try { await stopServerTuning(activeUrl); } catch (err: any) {
            setError(err?.response?.data?.error || err.message);
        }
    };

    const running = !!runStatus?.running;

    // Count the integers the user has entered, to validate against the engine's count.
    const entered = text.split(/\s+/).filter(Boolean);
    const enteredCount = entered.length;
    const lengthOk = count == null || enteredCount === count;

    const apply = async () => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res: any = await applyTuningParams(text, activeUrl);
            setApplied(true);
            setNotice(`Applied ${res?.count ?? enteredCount} parameters${res?.liveApplied ? " (live)" : ""}.`);
        } catch (err: any) {
            setError(err?.response?.data?.error || err.message || "Failed to apply");
        } finally {
            setBusy(false);
        }
    };

    const revert = async () => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res: any = await clearTuningParams(activeUrl);
            setApplied(false);
            setNotice(res?.note || "Cleared. Defaults return on the next engine restart.");
        } catch (err: any) {
            setError(err?.response?.data?.error || err.message || "Failed to clear");
        } finally {
            setBusy(false);
        }
    };

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setText(await file.text());
        e.target.value = "";
    };

    return (
        <div className="space-y-6 animate-in fade-in duration-500 max-w-4xl">
            <header>
                <h1 className="text-3xl font-black text-white mb-2 tracking-tight flex items-center gap-3">
                    <SlidersHorizontal className="text-purple-400" /> Eval Tuning
                </h1>
                <p className="text-slate-400">
                    Apply the results of a Texel tuning run. Paste the tuned parameter vector
                    (whitespace-separated integers, in the engine's parameter order) and the
                    engine will use it on every spawn.
                </p>
            </header>

            {/* Server-driven tuning: build a dataset from DB games and run the
                Texel tuner on the remote host over SSH, then auto-apply. */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-lg p-5 flex flex-col gap-4">
                <h2 className="font-bold text-white flex items-center gap-2">
                    <Server size={18} className="text-purple-400" /> Run tuning on server
                </h2>
                <p className="text-sm text-slate-400 -mt-2">
                    Builds a Texel dataset from recent games in the database, runs the tuner on
                    the remote host, and applies the optimized parameters automatically.
                </p>

                <div className="flex items-end gap-4 flex-wrap">
                    <div>
                        <label className="block text-xs text-slate-400 font-semibold mb-1">DB games</label>
                        <input type="number" min={10} step={10} value={games} disabled={running}
                            onChange={e => setGames(Number(e.target.value))}
                            className="w-28 bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg focus:outline-none focus:border-purple-500" />
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400 font-semibold mb-1">Max epochs</label>
                        <input type="number" min={1} value={maxEpochs} disabled={running}
                            onChange={e => setMaxEpochs(Number(e.target.value))}
                            className="w-28 bg-slate-950 border border-slate-700 text-sm text-white px-3 py-2 rounded-lg focus:outline-none focus:border-purple-500" />
                    </div>
                    {running ? (
                        <button onClick={stopServer}
                            className="ml-auto px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 bg-red-600 hover:bg-red-500 text-white transition-colors">
                            <Square size={14} fill="currentColor" /> Stop
                        </button>
                    ) : (
                        <button onClick={startRun}
                            className="ml-auto px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 bg-purple-600 hover:bg-purple-500 text-white transition-colors">
                            <Play size={16} fill="currentColor" /> Run tuning
                        </button>
                    )}
                </div>

                {runStatus && runStatus.phase !== "idle" && (
                    <div className="bg-slate-950 border border-slate-800 rounded-lg p-3 text-sm flex flex-wrap items-center gap-x-6 gap-y-1 font-mono">
                        <span className={`font-bold ${runStatus.phase === "failed" ? "text-red-400" : runStatus.phase === "done" ? "text-emerald-400" : "text-purple-300"}`}>
                            {runStatus.phase}
                        </span>
                        {runStatus.positions > 0 && <span className="text-slate-400">positions {runStatus.positions}</span>}
                        {runStatus.epoch > 0 && <span className="text-slate-400">epoch {runStatus.epoch}/{runStatus.maxEpochs}</span>}
                        {runStatus.mse != null && <span className="text-slate-400">mse {Number(runStatus.mse).toFixed(6)}</span>}
                        {runStatus.appliedCount != null && <span className="text-emerald-400">applied {runStatus.appliedCount} params</span>}
                        {runStatus.error && <span className="text-red-400">— {runStatus.error}</span>}
                    </div>
                )}
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-lg p-5 flex flex-col gap-4">
                <div className="flex items-center gap-4 text-sm">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${applied ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-700/40 text-slate-400"}`}>
                        {applied ? "Tuned params applied" : "Using compiled defaults"}
                    </span>
                    {count != null && (
                        <span className="text-slate-400 font-mono">
                            engine expects <span className="text-slate-200">{count}</span> params
                        </span>
                    )}
                    <button onClick={load} disabled={loading}
                        className="ml-auto text-xs text-slate-400 hover:text-white flex items-center gap-1.5 disabled:opacity-40">
                        <Download size={14} /> {loading ? "Loading…" : "Load current"}
                    </button>
                </div>

                <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    spellCheck={false}
                    placeholder="Paste tuned parameters here (one integer per line, or space-separated)…"
                    className="w-full h-80 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 focus:outline-none focus:border-purple-500 resize-y"
                />

                <div className="flex items-center gap-3 flex-wrap">
                    <span className={`text-xs font-mono ${lengthOk ? "text-slate-400" : "text-amber-400"}`}>
                        {enteredCount} entered{count != null ? ` / ${count} expected` : ""}
                        {!lengthOk && " — count mismatch"}
                    </span>

                    <label className="ml-auto text-xs text-slate-400 hover:text-white flex items-center gap-1.5 cursor-pointer">
                        <Upload size={14} /> Upload file
                        <input type="file" accept=".txt,text/plain" onChange={onFile} className="hidden" />
                    </label>

                    <button onClick={revert} disabled={busy || !applied}
                        className="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors">
                        <RotateCcw size={15} /> Revert to defaults
                    </button>
                    <button onClick={apply} disabled={busy || enteredCount === 0 || !lengthOk}
                        className="px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors">
                        <Check size={16} /> {busy ? "Applying…" : "Apply"}
                    </button>
                </div>

                {error && <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2">{error}</p>}
                {notice && <p className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-2">{notice}</p>}
            </div>

            <p className="text-xs text-slate-500">
                Applied params take effect immediately on the managed engine and on every new
                engine spawn (including Lichess games). Reverting removes the stored file;
                compiled defaults return when engines next restart.
            </p>
        </div>
    );
}
