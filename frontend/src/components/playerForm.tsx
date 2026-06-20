import React, { useState } from 'react';

const PlayerForm = ({ onStartGame }) => {
    const [player1Id, setPlayer1Id] = useState('');
    const [player2Id, setPlayer2Id] = useState('');

    const handleStartGame = () => {
        onStartGame(player1Id, player2Id);
        setPlayer1Id('');
        setPlayer2Id('');
    };

    return (
        <div className="flex flex-col items-center space-y-2">
            <input
                type="text"
                placeholder="Player 1 ID"
                value={player1Id}
                onChange={(e) => setPlayer1Id(e.target.value)}
                className="border p-2"
            />
            <input
                type="text"
                placeholder="Player 2 ID"
                value={player2Id}
                onChange={(e) => setPlayer2Id(e.target.value)}
                className="border p-2"
            />
            <button onClick={handleStartGame} className="bg-green-500 text-white px-4 py-2 rounded">
                Start Game
            </button>
        </div>
    );
};

export default PlayerForm;
