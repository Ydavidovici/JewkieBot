import React, { useState } from 'react';

interface OpeningExplorerProps {
    data: any;
    onMoveClick?: (uci: string) => void;
}

export default function OpeningExplorer({ data, onMoveClick }: OpeningExplorerProps) {
    const [source, setSource] = useState<'lichess' | 'masters' | 'book'>('lichess');

    if (!data) return null;

    let moves: any[] = [];
    if (source === 'lichess' && data.lichess?.moves) moves = data.lichess.moves;
    if (source === 'masters' && data.masters?.moves) moves = data.masters.moves;
    if (source === 'book' && data.book) moves = data.book;

    // Determine if we should completely hide (e.g. late game where no book data exists at all)
    const hasLichess = data.lichess?.moves && data.lichess.moves.length > 0;
    const hasBook = data.book && data.book.length > 0;
    const hasMasters = data.masters?.moves && data.masters.moves.length > 0;
    
    if (!hasLichess && !hasBook && !hasMasters) {
        return null;
    }

    return (
        <div className="bg-slate-950 rounded-xl border border-slate-800 flex flex-col overflow-hidden shadow-inner shrink-0 mb-4">
            <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex justify-between items-center">
                <h3 className="text-xs font-bold tracking-widest text-emerald-400 uppercase">Opening Explorer</h3>
                <div className="flex gap-1 text-[10px] font-bold">
                    <button 
                        onClick={() => setSource('lichess')} 
                        className={`px-2 py-1 rounded transition-colors ${source === 'lichess' ? 'bg-slate-700 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        LICHESS
                    </button>
                    <button 
                        onClick={() => setSource('masters')} 
                        className={`px-2 py-1 rounded transition-colors ${source === 'masters' ? 'bg-slate-700 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        MASTERS
                    </button>
                    <button 
                        onClick={() => setSource('book')} 
                        className={`px-2 py-1 rounded transition-colors ${source === 'book' ? 'bg-slate-700 text-white shadow' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        THEORY (.BIN)
                    </button>
                </div>
            </div>
            <div className="p-0 overflow-auto max-h-48">
                <table className="w-full text-xs text-left">
                    <thead className="bg-slate-900/50 text-slate-400 border-b border-slate-800 sticky top-0 backdrop-blur-sm">
                        <tr>
                            <th className="px-4 py-2 font-semibold">Move</th>
                            {source !== 'book' && <th className="px-4 py-2 font-semibold text-right">Games</th>}
                            {source === 'book' && <th className="px-4 py-2 font-semibold text-right">Weight</th>}
                            {source !== 'book' && <th className="px-4 py-2 font-semibold">Score</th>}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                        {moves.length === 0 && (source === 'lichess' && data.lichess?.error === 'auth_required' || source === 'masters' && data.masters?.error === 'auth_required') && (
                            <tr><td colSpan={4} className="px-4 py-4 text-center text-red-400 font-medium">Lichess now requires an API Token.<br/><span className="text-slate-500 text-[10px]">Add LICHESS_TOKEN to your backend .env</span></td></tr>
                        )}
                        {moves.length === 0 && !(data.lichess?.error === 'auth_required') && !(data.masters?.error === 'auth_required') && (
                            <tr><td colSpan={4} className="px-4 py-4 text-center text-slate-600 italic font-medium">No moves found in this database.</td></tr>
                        )}
                        {moves.map((m, i) => {
                            const total = source === 'book' ? 0 : (m.white + m.draws + m.black);
                            const whitePct = source === 'book' ? 0 : Math.round((m.white / total) * 100) || 0;
                            const drawPct = source === 'book' ? 0 : Math.round((m.draws / total) * 100) || 0;
                            const blackPct = source === 'book' ? 0 : Math.round((m.black / total) * 100) || 0;

                            return (
                                <tr 
                                    key={m.uci || i} 
                                    className="hover:bg-slate-800/50 cursor-pointer transition-colors" 
                                    onClick={() => onMoveClick && onMoveClick(m.uci)}
                                >
                                    <td className="px-4 py-2 font-mono text-slate-200 font-medium">{m.san || m.uci}</td>
                                    {source !== 'book' && <td className="px-4 py-2 text-right text-slate-400">{total.toLocaleString()}</td>}
                                    {source === 'book' && <td className="px-4 py-2 text-right text-emerald-400 font-mono">{m.weight}</td>}
                                    {source !== 'book' && (
                                        <td className="px-4 py-2 w-32">
                                            <div className="flex h-4 rounded overflow-hidden bg-slate-800 w-full shadow-inner text-[9px] font-bold leading-4 select-none">
                                                {whitePct > 0 && (
                                                    <div style={{width: `${whitePct}%`}} className="bg-slate-200 text-slate-900 flex justify-center items-center overflow-hidden" title={`White: ${whitePct}%`}>
                                                        {whitePct > 12 ? `${whitePct}%` : ''}
                                                    </div>
                                                )}
                                                {drawPct > 0 && (
                                                    <div style={{width: `${drawPct}%`}} className="bg-slate-500 text-slate-100 flex justify-center items-center overflow-hidden border-l border-r border-slate-600/30" title={`Draw: ${drawPct}%`}>
                                                        {drawPct > 12 ? `${drawPct}%` : ''}
                                                    </div>
                                                )}
                                                {blackPct > 0 && (
                                                    <div style={{width: `${blackPct}%`}} className="bg-slate-900 text-slate-300 flex justify-center items-center overflow-hidden" title={`Black: ${blackPct}%`}>
                                                        {blackPct > 12 ? `${blackPct}%` : ''}
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
