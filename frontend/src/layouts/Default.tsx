import React from "react";
import { Outlet, NavLink } from "react-router-dom";
import { useBot } from "../context/BotContext.jsx";
import { LayoutDashboard, Gamepad2, Settings, Activity, LineChart, Database, Swords, SlidersHorizontal } from "lucide-react";

export default function Default() {
    const { env, activeStatus } = useBot();
    const online = !!activeStatus?.health;

    // Full literal class strings (Tailwind can't see interpolated color names).
    const envStyles = {
        prod: { label: "Production", chip: "bg-blue-600/20 border-blue-500/50 text-blue-100", dot: "bg-blue-400", icon: "bg-blue-500/20 text-blue-400" },
        dev: { label: "Development", chip: "bg-purple-600/20 border-purple-500/50 text-purple-100", dot: "bg-purple-400", icon: "bg-purple-500/20 text-purple-400" },
        local: { label: "Local", chip: "bg-green-600/20 border-green-500/50 text-green-100", dot: "bg-green-400", icon: "bg-green-500/20 text-green-400" },
    };
    const e = envStyles[env] ?? envStyles.prod;

    return (
        <div className="flex min-h-screen bg-slate-950 text-slate-100 font-sans">
            {/* Premium Sidebar */}
            <aside className="w-64 flex flex-col bg-slate-900 border-r border-slate-800 shadow-2xl z-20">
                <div className="p-6 border-b border-slate-800">
                    <h1 className="text-2xl font-black bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent flex items-center gap-2 tracking-tight">
                        ♞ JewkieBot
                    </h1>
                </div>

                {/* Environment badge — which backend served this app (read-only;
                    switch environments by visiting the other origin). */}
                <div className="p-4 border-b border-slate-800">
                    <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-3">Environment</p>
                    <div className={`flex items-center justify-between px-3 py-2 rounded-md border ${e.chip}`}>
                        <span className="text-sm font-bold">{e.label} Bot</span>
                        <div className={`w-2.5 h-2.5 rounded-full ${online ? `${e.dot} animate-pulse` : "bg-red-500"}`} />
                    </div>
                </div>

                <nav className="flex-1 p-4 flex flex-col gap-2">
                    <p className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-2 mt-2">Navigation</p>
                    
                    <NavLink to="/" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <LayoutDashboard size={18} /> Dashboard
                    </NavLink>
                    <NavLink to="/analysis" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <LineChart size={18} /> Game Analysis
                    </NavLink>
                    <NavLink to="/game" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <Gamepad2 size={18} /> Play vs Engine
                    </NavLink>
                    <NavLink to="/selfplay" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <Swords size={18} /> Self-Play
                    </NavLink>
                    <NavLink to="/lichess" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <Settings size={18} /> Lichess Control
                    </NavLink>
                    <NavLink to="/tasks" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <Database size={18} /> Tasks & Integration
                    </NavLink>
                    <NavLink to="/tuning" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <SlidersHorizontal size={18} /> Eval Tuning
                    </NavLink>
                    <NavLink to="/benchmark" className={({isActive}) => `flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all text-sm font-medium ${isActive ? "bg-slate-800 text-white shadow-md border border-slate-700" : "text-slate-400 hover:text-white hover:bg-slate-800/50 border border-transparent"}`}>
                        <Activity size={18} /> Diagnostics
                    </NavLink>
                </nav>
            </aside>

            {/* Main Content Area */}
            <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-slate-950">
                <header className="h-16 border-b border-slate-800 flex items-center px-8 bg-slate-900/80 backdrop-blur-md sticky top-0 z-10">
                    <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-lg ${e.icon}`}>
                            <Activity size={18} />
                        </div>
                        <h2 className="text-lg font-semibold tracking-tight text-white">
                            {e.label} Environment
                        </h2>
                    </div>
                    <div className="ml-auto flex items-center gap-4 text-sm font-medium">
                        {activeStatus?.health ? (
                            <span className="flex items-center gap-2 bg-green-500/10 text-green-400 px-4 py-1.5 rounded-full border border-green-500/20 shadow-[0_0_10px_rgba(34,197,94,0.1)]">
                                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" /> Connected to Backend
                            </span>
                        ) : (
                            <span className="flex items-center gap-2 bg-red-500/10 text-red-400 px-4 py-1.5 rounded-full border border-red-500/20">
                                <div className="w-2 h-2 rounded-full bg-red-500" /> Disconnected
                            </span>
                        )}
                    </div>
                </header>
                
                <div className="flex-1 overflow-auto p-8 relative">
                    <Outlet />
                </div>
            </main>
        </div>
    );
}