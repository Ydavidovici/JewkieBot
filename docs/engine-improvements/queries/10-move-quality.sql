-- Move quality from the stored Stockfish analysis, for doc 10.
-- Run: bun scripts/db-query.ts apps/jewkiebot/docs/engine-improvements/queries/10-move-quality.sql
--
-- Conventions (backend/src/gameAnalyzer.ts):
--   ply starts at 1 = White's first move, so odd plies are White's moves.
--   best_cp    = Stockfish eval BEFORE the move, mover's point of view
--   played_cp  = Stockfish eval AFTER the move, mover's point of view
--   cp_loss    = max(0, best_cp - played_cp); classification good<=10, inaccuracy<=50, mistake<=100, else blunder
--   student_cp / student_uci = jewkiebot's own eval / preferred move for the position BEFORE the move
--   Mate scores are stored as +/-10000 (engineManager.go), so mate rows are excluded or capped below.
-- Phase uses non-pawn, non-king piece count in fen_after: opening = ply <= 20,
-- endgame = at most 6 such pieces on the board, otherwise middlegame.

-- name: 1. Analysis coverage
select count(distinct g.id) as games_with_evals,
       count(*) as eval_rows,
       count(*) filter (where e.student_cp is not null) as rows_with_jewkiebot_eval,
       min(g.started_at) as first_game, max(g.started_at) as last_game
from jewkiebot_chess_move_evals e
join jewkiebot_chess_game_moves m on m.id = e.move_id
join jewkiebot_chess_games g on g.id = m.game_id;

-- name: 2. Bot vs opponent move quality by phase (non-self-play)
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
mv as (
  select e.*, m.uci, m.fen_after,
    case when (m.ply % 2 = 1) = (g.white_id in (select id from bot)) then 'bot' else 'opponent' end as mover,
    case when m.ply <= 20 then '1 opening'
         when length(regexp_replace(split_part(m.fen_after, ' ', 1), '[^nbrqNBRQ]', '', 'g')) <= 6 then '3 endgame'
         else '2 middlegame' end as phase
  from jewkiebot_chess_move_evals e
  join jewkiebot_chess_game_moves m on m.id = e.move_id
  join jewkiebot_chess_games g on g.id = m.game_id
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
    and not e.is_mate and abs(e.best_cp) < 1000 and e.cp_loss is not null
)
select phase, mover, count(*) as moves,
       round(avg(least(cp_loss, 500))) as avg_cp_loss_capped500,
       round(100.0 * count(*) filter (where classification = 'blunder') / count(*), 1) as blunder_pct,
       round(100.0 * count(*) filter (where classification = 'mistake') / count(*), 1) as mistake_pct,
       round(100.0 * count(*) filter (where classification = 'inaccuracy') / count(*), 1) as inaccuracy_pct
from mv
group by 1, 2
order by 1, 2;

-- name: 3. Bot blunders by how the position stood (non-self-play)
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
mv as (
  select e.*
  from jewkiebot_chess_move_evals e
  join jewkiebot_chess_game_moves m on m.id = e.move_id
  join jewkiebot_chess_games g on g.id = m.game_id
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
    and (m.ply % 2 = 1) = (g.white_id in (select id from bot))
    and not e.is_mate and abs(e.best_cp) < 1000 and e.cp_loss is not null
)
select case when best_cp >= 300 then '1 winning (>= +3)'
            when best_cp >= 100 then '2 better (+1..+3)'
            when best_cp > -100 then '3 equal (-1..+1)'
            when best_cp > -300 then '4 worse (-3..-1)'
            else '5 losing (<= -3)' end as position_before_move,
       count(*) as moves,
       round(avg(least(cp_loss, 500))) as avg_cp_loss_capped500,
       round(100.0 * count(*) filter (where classification = 'blunder') / count(*), 1) as blunder_pct
from mv
group by 1
order by 1;

-- name: 4. jewkiebot's own eval vs Stockfish's, bot's positions (non-mate, |SF| < 1000)
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
mv as (
  select e.*,
    case when m.ply <= 20 then '1 opening'
         when length(regexp_replace(split_part(m.fen_after, ' ', 1), '[^nbrqNBRQ]', '', 'g')) <= 6 then '3 endgame'
         else '2 middlegame' end as phase
  from jewkiebot_chess_move_evals e
  join jewkiebot_chess_game_moves m on m.id = e.move_id
  join jewkiebot_chess_games g on g.id = m.game_id
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
    and (m.ply % 2 = 1) = (g.white_id in (select id from bot))
    and e.student_cp is not null and not e.is_mate
    and abs(e.best_cp) < 1000 and abs(e.student_cp) < 1000
)
select phase, count(*) as positions,
       round(avg(student_cp - best_cp)) as avg_bias_cp,
       round(avg(abs(student_cp - best_cp))) as avg_abs_diff_cp,
       round(100.0 * count(*) filter (where abs(student_cp - best_cp) > 150) / count(*), 1) as pct_off_by_150plus,
       round(100.0 * count(*) filter (where student_uci = best_uci) / count(*), 1) as pct_same_best_move
from mv
group by 1
order by 1;

-- name: 5. Thrown games: losses where the bot was at least +2 at some point
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
lost as (
  select g.id, g.lichess_game_id, g.termination, g.time_control
  from jewkiebot_chess_games g
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
    and ((g.result = '1-0' and g.black_id in (select id from bot))
      or (g.result = '0-1' and g.white_id in (select id from bot)))
),
peak as (
  select l.id, max(e.best_cp) as best_bot_eval
  from lost l
  join jewkiebot_chess_game_moves m on m.game_id = l.id
  join jewkiebot_chess_move_evals e on e.move_id = m.id
  join jewkiebot_chess_games g on g.id = l.id
  where (m.ply % 2 = 1) = (g.white_id in (select id from bot))
  group by l.id
)
select count(*) as analyzed_losses,
       count(*) filter (where best_bot_eval >= 200) as were_plus2_or_better,
       count(*) filter (where best_bot_eval >= 500) as were_plus5_or_better,
       round(100.0 * count(*) filter (where best_bot_eval >= 200) / nullif(count(*), 0), 1) as pct_thrown
from peak;

-- name: 6. Worst 15 bot moves (non-mate), with game links
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%')
select g.lichess_game_id, m.ply, m.uci as played, e.best_uci as stockfish_best, e.student_uci as jewkiebot_best,
       e.best_cp, e.played_cp, e.cp_loss
from jewkiebot_chess_move_evals e
join jewkiebot_chess_game_moves m on m.id = e.move_id
join jewkiebot_chess_games g on g.id = m.game_id
where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
  and (m.ply % 2 = 1) = (g.white_id in (select id from bot))
  and not e.is_mate and abs(e.best_cp) < 1000 and abs(e.played_cp) < 1000
order by e.cp_loss desc
limit 15;
