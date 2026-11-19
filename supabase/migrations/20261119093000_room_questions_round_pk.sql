-- Fragen gehören wie Antworten und Versuche zu einer Runde (Primärschlüssel pro Runde).
alter table public.room_questions drop constraint room_questions_pkey;
alter table public.room_questions add primary key (room_id, round, idx);
