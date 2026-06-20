import React from 'react';

const Sidebar = ({ player1, player2, gameId, gameStatus }) => {
    return (
        <div className="w-1/4 bg-gray-100 p-4">
            <h2 className="text-2xl font-bold mb-4">Game Info</h2>
            <p><strong>Player 1:</strong> {player1}</p>
            <p><strong>Player 2:</strong> {player2}</p>
            <p><strong>Game ID:</strong> {gameId}</p>
            <p><strong>Status:</strong> {gameStatus}</p>
        </div>
    );
};

export default Sidebar;
