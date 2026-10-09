// HUD helpers shared by the top-down and first-person clients. Both pages use the same element ids.
(function () {
  const $ = id => document.getElementById(id);

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function addFeed(html, highlight) {
    const el = document.createElement('div');
    el.innerHTML = html;
    if (highlight) el.className = 'me';
    $('feed').prepend(el);
    while ($('feed').children.length > 6) $('feed').lastChild.remove();
    setTimeout(() => el.remove(), 6000);
  }

  function scoreRows(scores, myId) {
    return '<tr><th>Box</th><th class="n">Cuts</th><th class="n">Deaths</th></tr>' + scores.map(s =>
      `<tr class="${s.id === myId ? 'me' : ''}"><td>${esc(s.name)}${s.bot ? '<span class="bot">BOT</span>' : ''}</td><td class="n">${s.score}</td><td class="n">${s.deaths}</td></tr>`
    ).join('');
  }

  function renderScores(scores, myId) {
    $('score-table').innerHTML = scoreRows(scores, myId);
    const mine = scores.find(s => s.id === myId);
    if (mine) { $('kills').textContent = mine.score; $('deaths').textContent = mine.deaths; }
  }

  function showRoundEnd(scores, myId) {
    const top = scores[0];
    $('winner').textContent = top && top.score > 0 ? `${top.name} wins!` : 'Nobody got cut!';
    $('final-table').innerHTML = scoreRows(scores, myId);
    $('intermission').classList.remove('hidden');
    $('death').classList.add('hidden');
  }

  function hideRoundEnd() { $('intermission').classList.add('hidden'); }

  function showDeath(killer) {
    $('death-by').textContent = `${killer} got you with a box cutter`;
    $('death').classList.remove('hidden');
  }

  function hideDeath() { $('death').classList.add('hidden'); }

  // Per-frame HUD: timer, cutter cooldown, stamina, respawn countdown.
  function updateHud({ phase, timeLeft, cdLeft, cdTotal, stamina, exhausted, respawnIn }) {
    const m = Math.floor(timeLeft / 60), s = Math.floor(timeLeft % 60);
    $('timer').textContent = phase === 'play' ? `${m}:${String(s).padStart(2, '0')}` : 'ROUND OVER';
    $('timer').classList.toggle('low', phase === 'play' && timeLeft < 30);
    $('next-t').textContent = Math.ceil(timeLeft);
    $('cd-fill').style.width = `${(1 - Math.min(Math.max(cdLeft / cdTotal, 0), 1)) * 100}%`;
    $('cd-fill').classList.toggle('cooling', cdLeft > 0);
    $('st-fill').style.width = `${stamina * 100}%`;
    $('st-fill').classList.toggle('tired', exhausted);
    if (respawnIn !== null) $('respawn-t').textContent = Math.max(0, Math.ceil(respawnIn));
  }

  function renderOptions(options) {
    $('opts').innerHTML = `Decoys: <b>${options.moveDecoys ? 'MOVING' : 'STILL'}</b> <kbd>M</kbd> to toggle`;
  }

  // Active power-ups with countdown bars. `powers` maps type -> expiry (performance.now() ms).
  let powersHtml = '';
  function renderPowers(powers, t) {
    const html = Object.entries(powers).filter(([, until]) => until > t).map(([type, until]) => {
      const def = Shared.POWERS[type], left = (until - t) / 1000;
      return `<div class="power" style="--c:${def.color}"><i style="width:${Math.min(100, Math.round(left / def.dur * 100))}%"></i>` +
        `<span class="pi">${def.icon}</span><span class="pn">${esc(def.name)}</span><span class="pt">${Math.ceil(left)}s</span></div>`;
    }).join('');
    if (html !== powersHtml) { $('powers').innerHTML = html; powersHtml = html; }
  }

  // Big centred announcement, e.g. when you crack open a power-up.
  function toast(title, sub, color) {
    const el = $('toast');
    el.innerHTML = `<b style="color:${color}">${esc(title)}</b><span>${esc(sub)}</span>`;
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
  }

  function bindScoreboardKey() {
    addEventListener('keydown', e => {
      if (e.code === 'Tab') { e.preventDefault(); $('scoreboard').classList.remove('hidden'); }
    });
    addEventListener('keyup', e => { if (e.code === 'Tab') $('scoreboard').classList.add('hidden'); });
    addEventListener('blur', () => $('scoreboard').classList.add('hidden'));
  }

  window.UI = { $, esc, addFeed, renderScores, showRoundEnd, hideRoundEnd, showDeath, hideDeath, updateHud, renderOptions, renderPowers, toast, bindScoreboardKey };
})();
