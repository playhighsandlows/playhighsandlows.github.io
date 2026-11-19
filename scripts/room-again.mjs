/**
 * Regressionstest „Nochmal“ im Freunde-Modus (gegen das echte Projekt):
 * 12 Spieler (Gastgeber, ein zweiter Spieler, 10 Bots) spielen eine Runde, dann 3× „Nochmal“.
 * Jede neue Runde muss sauber beginnen: niemand hat schon geantwortet, kein my_answer
 * (= Eingabefeld da), keine alten Versuche/Punkte/Fragen, Antworten werden angenommen,
 * die Serie zählt die Punkte der früheren Runden.
 *
 *   node scripts/room-again.mjs [Runden=4]
 */
import { assert, bots, call, listAnswers, state, waitFor } from './lib/room-bots.mjs';

const ROUNDS = Number(process.argv[2] ?? 4);
const players = await bots(12, 'Serie');
const [host, second] = players;
const r = await call(host, 'create', { name: host.name, settings: { mode: 'rare', scoring: 'group', source: 'random', count: 5, seconds: 15, lang: 'de' } });
assert(r.status === 200, `create ${JSON.stringify(r.body)}`);
const code = r.body.code;
for (const p of players.slice(1)) assert((await call(p, 'join', { code, name: p.name })).status === 200, `join ${p.name}`);
console.log(`Raum ${code}: ${players.length} Spieler`);

const series = new Map(players.map((p) => [p.id, 0]));
let prevPrompts = [];
for (let round = 1; round <= ROUNDS; round++) {
  if (round > 1) {
    const a = await call(host, 'again', { code });
    assert(a.status === 200, `again ${JSON.stringify(a.body)}`);
    // doppelter Klick darf nichts kaputt machen
    const twice = await call(host, 'again', { code });
    assert(twice.status === 409, `zweites „Nochmal“ nicht abgefangen: ${JSON.stringify(twice.body)}`);
    const lobby = await state(second, code);
    assert(lobby.status === 'lobby' && lobby.round === round, `nicht in der Lobby der Runde ${round}: ${lobby.status}/${lobby.round}`);
    assert(lobby.players.length === players.length, 'Spieler fehlen nach „Nochmal“');
    for (const p of lobby.players) assert(p.series_points === series.get(p.user_id), `Serie ${p.name}: ${p.series_points} statt ${series.get(p.user_id)}`);
    assert(lobby.players.every((p) => p.points === 0 && p.series_rounds === round - 1), 'Punkte/Runden der Serie falsch');
  }
  assert((await call(host, 'start', { code })).status === 200, `start Runde ${round}`);
  const prompts = [];
  for (;;) {
    // der Gastgeber meldet sich wie ein echtes Gerät regelmäßig (sonst gibt der Server die Rolle nach 45 s weiter)
    await state(host, code);
    const st = await waitFor(second, code, (s) => (s.status === 'question' && !prompts.includes(s.question.prompt)) || s.status === 'finished', 60_000);
    if (st.status === 'finished') break;
    // Kernprüfung: die neue Frage ist leer – jeder sieht ein Eingabefeld
    assert(st.round === round, `Zustand aus Runde ${st.round}`);
    assert(st.my_answer === null, `Runde ${round}, Frage ${st.index + 1}: alte Antwort als my_answer „${st.my_answer}“ – kein Eingabefeld`);
    assert((st.my_attempts ?? []).length === 0, `alte Versuche sichtbar: ${JSON.stringify(st.my_attempts)}`);
    assert(st.players.every((p) => !p.answered && p.attempts === 0), 'alte „hat geantwortet“-Häkchen oder Versuchszähler');
    assert(st.reveal === null, 'alte Auflösung sichtbar');
    prompts.push(st.question.prompt);
    const list = (await listAnswers(code, st.index)).sort((a, b) => b.baseScore - a.baseScore);
    // jeder antwortet (einer zuerst falsch); jede Antwort muss angenommen werden
    await Promise.all(
      players.map(async (p, i) => {
        if (i === 1) {
          const w = await call(p, 'answer', { code, idx: st.index, answer: 'zzzz' });
          assert(w.status === 200 && w.body.accepted === false, `Fehlversuch: ${JSON.stringify(w.body)}`);
        }
        const a = await call(p, 'answer', { code, idx: st.index, answer: list[i % Math.min(4, list.length)].text });
        assert(a.status === 200 && a.body.accepted === true, `Runde ${round}: Antwort von ${p.name} nicht angenommen: ${JSON.stringify(a.body)}`);
      }),
    );
    const rv = await waitFor(second, code, (s) => s.status === 'reveal' || s.status === 'finished', 30_000);
    const n = Object.values(rv.reveal.players).filter((x) => x.answer !== null).length;
    assert(n === players.length, `Auflösung mit ${n} statt ${players.length} Antworten`);
    assert(rv.reveal.players[second.id].attempts === 2, 'Versuche der neuen Runde falsch gezählt');
    await call(host, 'next', { code });
  }
  const fin = await state(second, code);
  assert(fin.status === 'finished' && (fin.reveals ?? []).length === prompts.length, `Endstand: ${fin.status}, ${fin.reveals?.length} Auflösungen`);
  for (const p of fin.players) series.set(p.user_id, series.get(p.user_id) + p.points);
  const same = prompts.filter((q) => prevPrompts.includes(q)).length;
  console.log(`Runde ${round}: ${prompts.length} Fragen, alle ${players.length} Antworten angenommen, Serie Gastgeber ${series.get(host.id)}${same ? ` (${same} Frage(n) wie vorher)` : ''}`);
  prevPrompts = prompts;
}
for (const p of players) await call(p, 'leave', { code });
console.log(`„Nochmal“ ${ROUNDS - 1}× OK`);
process.exit(0);
