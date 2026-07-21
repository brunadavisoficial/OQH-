-- ============================================================
-- OQHá · Camada 2 — tabela de vivacidade prevista
-- Guarda o resultado do motor de previsão, atualizado a cada rodada.
-- Fica separada de `estabelecimentos` pra não mexer no cadastro.
-- ============================================================

create table if not exists vivacidade (
  osm_id         text primary key references estabelecimentos(osm_id) on delete cascade,
  viv_prevista   real not null,                 -- 0..1 (a previsão P)
  trajetoria     text not null,                 -- subindo | pico | esvaziando
  fonte          text not null default 'previsao', -- previsao | medicao (Camada 4 sobrescreve)
  clima          text,                          -- sol | nublado | chuva (no momento do cálculo)
  atualizado_em  timestamptz not null default now()
);

create index if not exists idx_viv_prevista on vivacidade (viv_prevista desc);

-- O app lê os dois juntos assim:
--   select e.*, v.viv_prevista, v.trajetoria, v.clima
--   from estabelecimentos e
--   left join vivacidade v using (osm_id)
--   order by v.viv_prevista desc nulls last;

alter table vivacidade enable row level security;
drop policy if exists "leitura publica viv" on vivacidade;
create policy "leitura publica viv" on vivacidade for select using (true);
