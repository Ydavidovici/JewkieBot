import React, { useState } from 'react';

const GameControls = ({ gameId, onMakeMove }) => {
    const [move, setMove] = useState('');

    const handleMakeMove = () => {
        onMakeMove(gameId, move);
        setMove('');
    };

    return (
        <div className="flex flex-col items-center space-y-2">
            <input
                type="text"
                placeholder="Move"
                value={move}
                onChange={(e) => setMove(e.target.value)}
                className="border p-2"
            />
            <button onClick={handleMakeMove} className="bg-blue-500 text-white px-4 py-2 rounded">
                Make Move
            </button>
        </div>
    );
};

export default GameControls;
