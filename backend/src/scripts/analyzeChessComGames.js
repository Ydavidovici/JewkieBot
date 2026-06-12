import {chessComClient} from "../chessComClient.js";

console.log(await new chessComClient().fetchPlayer("dvids35"));