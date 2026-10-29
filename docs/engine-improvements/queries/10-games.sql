-- Game outcomes for doc 10 (where real games are lost) and doc 11 (openings).
-- Run: bun scripts/db-query.ts apps/jewkiebot/docs/engine-improvements/queries/10-games.sql
--      (from the dss root, with the SSH tunnel open — see scripts/db-query.ts)
-- The bot is identified by player name containing "jewkie" (check query 1 first).

-- name: 1. Players by number of games
select p.name, count(*) as games
from jewkiebot_chess_games g
join jewkiebot_chess_players p on p.id in (g.white_id, g.black_id)
group by p.name
order by games desc
limit 15;

-- name: 2. All games by environment, source and variant
select env, source, coalesce(variant, '?') as variant,
       count(*) as games,
       count(*) filter (where result is null) as no_result,
       min(started_at) as first, max(started_at) as last
from jewkiebot_chess_games
group by 1, 2, 3
order by games desc;

-- name: 3. Bot results by source and environment
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
bg as (
  select g.*,
    case when g.result = '1/2-1/2' then 'draw'
         when (g.result = '1-0' and g.white_id in (select id from bot))
           or (g.result = '0-1' and g.black_id in (select id from bot)) then 'win'
         when g.result in ('1-0', '0-1') then 'loss'
         else 'unknown' end as outcome,
    (g.white_id in (select id from bot) and g.black_id in (select id from bot)) as selfplay
  from jewkiebot_chess_games g
  where g.white_id in (select id from bot) or g.black_id in (select id from bot)
)
select source, env, selfplay, count(*) as games,
       count(*) filter (where outcome = 'win')  as wins,
       count(*) filter (where outcome = 'draw') as draws,
       count(*) filter (where outcome = 'loss') as losses,
       count(*) filter (where outcome = 'unknown') as unknown,
       round(100.0 * (count(*) filter (where outcome = 'win') + 0.5 * count(*) filter (where outcome = 'draw'))
             / nullif(count(*) filter (where outcome <> 'unknown'), 0), 1) as score_pct
from bg
group by 1, 2, 3
order by games desc;

-- name: 4. How the bot's non-self-play games end
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
bg as (
  select g.*,
    case when g.result = '1/2-1/2' then 'draw'
         when (g.result = '1-0' and g.white_id in (select id from bot))
           or (g.result = '0-1' and g.black_id in (select id from bot)) then 'win'
         when g.result in ('1-0', '0-1') then 'loss'
         else 'unknown' end as outcome
  from jewkiebot_chess_games g
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
)
select outcome, coalesce(termination, '?') as termination, count(*) as games,
       round(100.0 * count(*) / sum(count(*)) over (partition by outcome), 1) as pct_of_outcome
from bg
group by 1, 2
order by outcome, games desc;

-- name: 5. Results by time control (non-self-play, top 12)
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
bg as (
  select g.*,
    case when g.result = '1/2-1/2' then 'draw'
         when (g.result = '1-0' and g.white_id in (select id from bot))
           or (g.result = '0-1' and g.black_id in (select id from bot)) then 'win'
         when g.result in ('1-0', '0-1') then 'loss'
         else 'unknown' end as outcome
  from jewkiebot_chess_games g
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
)
select coalesce(time_control, '?') as time_control, count(*) as games,
       count(*) filter (where outcome = 'win') as w,
       count(*) filter (where outcome = 'draw') as d,
       count(*) filter (where outcome = 'loss') as l,
       count(*) filter (where outcome = 'loss' and termination in ('outoftime', 'timeout')) as lost_on_time,
       round(100.0 * (count(*) filter (where outcome = 'win') + 0.5 * count(*) filter (where outcome = 'draw'))
             / nullif(count(*) filter (where outcome <> 'unknown'), 0), 1) as score_pct
from bg
group by 1
order by games desc
limit 12;

-- name: 6. Results by opponent rating band (non-self-play, rated info present)
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
bg as (
  select g.*,
    case when g.white_id in (select id from bot) then g.black_rating else g.white_rating end as opp_rating,
    case when g.white_id in (select id from bot) then g.white_rating else g.black_rating end as bot_rating,
    case when g.result = '1/2-1/2' then 'draw'
         when (g.result = '1-0' and g.white_id in (select id from bot))
           or (g.result = '0-1' and g.black_id in (select id from bot)) then 'win'
         when g.result in ('1-0', '0-1') then 'loss'
         else 'unknown' end as outcome
  from jewkiebot_chess_games g
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
)
select (opp_rating / 200) * 200 as opp_rating_from, count(*) as games,
       round(avg(bot_rating)) as avg_bot_rating,
       round(100.0 * (count(*) filter (where outcome = 'win') + 0.5 * count(*) filter (where outcome = 'draw'))
             / nullif(count(*) filter (where outcome <> 'unknown'), 0), 1) as score_pct
from bg
where opp_rating is not null
group by 1
order by 1;

-- name: 7. Opening performance (non-self-play, >= 3 games, top 30 by games)
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
bg as (
  select g.*,
    case when g.white_id in (select id from bot) then 'white' else 'black' end as bot_color,
    case when g.result = '1/2-1/2' then 'draw'
         when (g.result = '1-0' and g.white_id in (select id from bot))
           or (g.result = '0-1' and g.black_id in (select id from bot)) then 'win'
         when g.result in ('1-0', '0-1') then 'loss'
         else 'unknown' end as outcome
  from jewkiebot_chess_games g
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
)
select coalesce(opening_name, '?') as opening, bot_color, count(*) as games,
       count(*) filter (where outcome = 'win') as w,
       count(*) filter (where outcome = 'draw') as d,
       count(*) filter (where outcome = 'loss') as l,
       round(100.0 * (count(*) filter (where outcome = 'win') + 0.5 * count(*) filter (where outcome = 'draw'))
             / nullif(count(*) filter (where outcome <> 'unknown'), 0), 1) as score_pct
from bg
group by 1, 2
having count(*) >= 3
order by games desc
limit 30;

-- name: 8. Results by month (non-self-play)
with bot as (select id from jewkiebot_chess_players where name ilike '%jewkie%'),
bg as (
  select g.*,
    case when g.result = '1/2-1/2' then 'draw'
         when (g.result = '1-0' and g.white_id in (select id from bot))
           or (g.result = '0-1' and g.black_id in (select id from bot)) then 'win'
         when g.result in ('1-0', '0-1') then 'loss'
         else 'unknown' end as outcome
  from jewkiebot_chess_games g
  where (g.white_id in (select id from bot)) <> (g.black_id in (select id from bot))
)
select to_char(date_trunc('month', started_at), 'YYYY-MM') as month, count(*) as games,
       count(*) filter (where outcome = 'loss' and termination in ('outoftime', 'timeout')) as lost_on_time,
       round(100.0 * (count(*) filter (where outcome = 'win') + 0.5 * count(*) filter (where outcome = 'draw'))
             / nullif(count(*) filter (where outcome <> 'unknown'), 0), 1) as score_pct
from bg
group by 1
order by 1;
