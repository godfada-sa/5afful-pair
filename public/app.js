(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var MAX_SECONDS = 240;
  var job = null, poll = null, method = 'code', dmPolls = 0, lastCode = '';
  var submitting = false, checking = false, reqId = 0, lastNumber = '';
  var batch = null, devices = 1, lastNumber2 = '', ids = [];
  var snd = function (n) { if (window.tfxSound) window.tfxSound.play(n); };
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // lets :active (the press effect) work on iPhone Safari
  document.addEventListener('touchstart', function () {}, { passive: true });

  // theme switch (dark is the default; the choice is remembered on this device)
  var root = document.documentElement, themeBtn = $('theme');
  function syncTheme() {
    var dark = root.getAttribute('data-theme') !== 'light';
    themeBtn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  function artReady() {   // both hero pictures decoded and ready to paint (never waits more than half a second)
    var imgs = [].slice.call(document.querySelectorAll('.art')), wait = new Promise(function (r) { setTimeout(r, 500); });
    return Promise.race([Promise.all(imgs.map(function (i) { return i.decode ? i.decode().catch(function () {}) : null; })), wait]);
  }
  artReady();                                            // both hero pictures are decoded in advance, so the switch below can be instant
  themeBtn.addEventListener('click', function () { if (window.TFTheme) window.TFTheme.toggle(); });
  syncTheme();
  window.addEventListener('tfx-theme', syncTheme);   // the phone's own light/dark setting changed

  // floating navigation: a deeper shadow once the page has scrolled, and the menu closes when you scroll
  var bar = $('island'), ticking = false, scrollT = 0;
  function onScroll() {
    if (ticking) return; ticking = true;
    requestAnimationFrame(function () {
      root.classList.add('scrolling'); clearTimeout(scrollT); scrollT = setTimeout(function () { root.classList.remove('scrolling'); }, 160);   // animations rest while the page moves
      bar.classList.toggle('scrolled', window.scrollY > 4);
      if (menuIsOpen && Math.abs(window.scrollY - menuAt) > 30) menuOpen(false);
      ticking = false;
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  // the navigation pill grows to show the pairing status (idle -> working -> ok / bad)
  var islText = $('isl-text'), islT = 0, islLock = false;
  function islandSet(state, text) {
    if (islLock && state !== 'idle') return;           // a finished result stays until the next attempt
    if (bar.getAttribute('data-state') === state && (!text || islText.textContent === text)) return;
    clearTimeout(islT);
    var drawer = bar.querySelector('.isl-drawer');
    if (state !== 'idle') drawer.setAttribute('aria-hidden', 'false');
    if (text) islText.textContent = text;
    bar.setAttribute('data-state', state);
    if (state === 'ok') snd('success'); else if (state === 'bad') snd('error');
    if (state === 'ok' || state === 'bad') {
      islLock = true;
      islT = setTimeout(function () { bar.setAttribute('data-state', 'idle'); drawer.setAttribute('aria-hidden', 'true'); }, 7000);
    }
    if (state === 'idle') drawer.setAttribute('aria-hidden', 'true');
  }
  function islandReset() { islLock = false; islandSet('idle'); }

  // menu (opens under the pill)
  var menuBtn = $('menu'), menuPanel = $('menupanel'), menuIsOpen = false, menuAt = 0, menuT = 0;
  function menuOpen(on) {
    if (on === menuIsOpen) return;
    menuIsOpen = on; clearTimeout(menuT);
    menuBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
    menuBtn.setAttribute('aria-label', on ? 'Close menu' : 'Open menu');
    if (on) { menuAt = window.scrollY; menuPanel.classList.remove('out'); menuPanel.hidden = false; syncMenu(); }
    else if (reduced) { menuPanel.hidden = true; }
    else { menuPanel.classList.add('out'); menuT = setTimeout(function () { menuPanel.hidden = true; menuPanel.classList.remove('out'); }, 200); }
  }
  function syncMenu() {
    var free = !$('step-number').hidden && !submitting;     // the shortcuts only work on the first screen
    $('m-code').disabled = !free; $('m-qr').disabled = !free;
  }
  menuBtn.addEventListener('click', function () { menuOpen(!menuIsOpen); });
  document.addEventListener('click', function (e) { if (menuIsOpen && !e.target.closest('#menupanel') && !e.target.closest('#menu')) menuOpen(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && menuIsOpen) { menuOpen(false); menuBtn.focus(); } });
  function menuPick(m) {
    menuOpen(false);
    setMethod(m);
    try { $('step-number').scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) { /* older browsers */ }
  }
  // sounds: a quiet tick on taps, a chime when linking works, a low note on errors (see sound.js)
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button, a.navlink, a.mi, a.cbtn') : null;
    if (!b || b.disabled) return;
    var id = b.id;
    if (id === 'theme') return snd(root.getAttribute('data-theme') === 'light' ? 'themeDark' : 'themeLight');
    if (id === 'menu') return snd(menuIsOpen ? 'close' : 'open');
    if (b.classList.contains('tab')) return snd('tab');
    if (b.classList.contains('mi') && id !== 'm-sound') { if (b.tagName === 'A') setTimeout(function () { menuOpen(false); }, 150); return snd('tap'); }
    if (b.classList.contains('link') || b.classList.contains('navlink') || b.classList.contains('cbtn')) return snd('tap');
  }, true);
  function syncSound() {
    var on = !!(window.tfxSound && window.tfxSound.isOn());
    $('m-sound').setAttribute('aria-checked', on ? 'true' : 'false');
    $('m-sound-t').textContent = 'Sound: ' + (on ? 'On' : 'Off');
  }
  if (window.tfxSound) {
    $('m-sound').addEventListener('click', function () { var v = window.tfxSound.set(!window.tfxSound.isOn()); syncSound(); if (v) snd('tap'); });
    syncSound();
  } else { $('m-sound').hidden = true; }
  $('m-code').addEventListener('click', function () { menuPick('code'); });
  $('m-qr').addEventListener('click', function () { menuPick('qr'); });
  onScroll();

  // swaps text with a short fade. Rapid calls keep only the latest text, so nothing flickers.
  function swapText(el, text) {
    if (el._t) clearTimeout(el._t);
    if (!el._t && el.textContent === text) return;
    if (reduced) { el.textContent = text; el.classList.remove('out'); el._t = 0; return; }
    el.classList.add('out');
    el._t = setTimeout(function () { el.textContent = text; el.classList.remove('out'); el._t = 0; }, 140);
  }
  // button feedback states: 'done' (copied), 'fail', 'shake'
  function flash(btn, cls, ms) {
    if (cls === 'shake' && window.tfxSound) window.tfxSound.play('error');
    btn.classList.remove('done', 'fail', 'shake'); void btn.offsetWidth;
    btn.classList.add(cls);
    if (btn._f) clearTimeout(btn._f);
    btn._f = setTimeout(function () { btn.classList.remove(cls); btn._f = 0; }, ms || 1800);
  }

  // ---------- helpers ----------
  function show(step) {
    ['step-number', 'step-wait', 'step-done'].forEach(function (s) {
      var el = $(s);
      var on = s === step;
      el.hidden = !on;
      if (on) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
    });
    toConnect(true);
    if (menuIsOpen) syncMenu();
  }
  // the page always opens on (and returns to) the connection section, just under the floating bar
  function toConnect(smooth) {
    var el = $('connect'), top = el.getBoundingClientRect().top + window.pageYOffset - (bar.getBoundingClientRect().bottom + 14);
    try { window.scrollTo({ top: Math.max(0, top), behavior: smooth && !reduced ? 'smooth' : 'instant' }); } catch (e) { window.scrollTo(0, Math.max(0, top)); }
  }
  // an unfinished attempt survives a refresh: only the attempt number is kept in this tab (never the session ID itself,
  // which the server hands out again while it is still valid)
  var JOBKEY = 'tfx-job', restoring = false;
  function saveJob() { try { sessionStorage.setItem(JOBKEY, JSON.stringify({ job: job, batch: batch, method: method, devices: devices })); } catch (e) { /* fine */ } }
  function clearJob() { try { sessionStorage.removeItem(JOBKEY); } catch (e) { /* fine */ } }
  function setText(el, msg) { el.textContent = msg || ''; el.hidden = !msg; }
  function stop() { if (poll) clearInterval(poll); poll = null; }

  // countdown for the finished session ID. The server sends how many seconds are left and also enforces it.
  var idTimer = null, idEnd = 0, slowPoll = false;
  function fmtLeft(s) { return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  function idStop() { if (idTimer) clearInterval(idTimer); idTimer = null; idEnd = 0; }
  function idExpired() {
    idStop(); clearJob(); stop();
    $('idtimer').textContent = 'This session ID has expired. Link again to get a new one.';
    $('idtimer').classList.add('gone');
    if (ids.length > 1) {
      [].forEach.call($('sidlist').querySelectorAll('.sid'), function (box) {
        box.classList.add('expired'); box.setAttribute('aria-disabled', 'true'); box.tabIndex = -1; box.textContent = 'Expired';
      });
      $('env').textContent = ids.map(function (id, k) { return (k === 0 ? 'SESSION_ID=' : 'account2=') + '(expired)'; }).join('\n');
    } else {
      $('sid').classList.add('expired'); $('sid').setAttribute('aria-disabled', 'true'); $('sid').tabIndex = -1;
      $('sid').textContent = 'Expired';
      $('env').textContent = 'SESSION_ID=(expired)';
    }
    $('copy').disabled = true; $('copyenv').disabled = true;
    $('dl').hidden = true; $('dl').removeAttribute('href');
    $('dlwait').hidden = false; $('dlwait').textContent = 'This index.js has expired. Link again to get a new one.';
  }
  // the bot has logged in with this session ID: say so instead of "expired"
  function idUsed() {
    idStop(); clearJob(); stop();
    $('step-done').classList.add('used'); $('usedmsg').hidden = false;
    $('idtimer').textContent = 'Used by your bot. It cannot be used again.'; $('idtimer').classList.remove('gone', 'low'); $('idtimer').classList.add('used');
    $('sid').classList.add('expired'); $('sid').setAttribute('aria-disabled', 'true'); $('sid').tabIndex = -1;
    $('sid').textContent = 'Used'; $('env').textContent = 'SESSION_ID=(used)';
    $('copy').disabled = true; $('copyenv').disabled = true;
    $('dm').textContent = '';
    islLock = false; islandSet('ok', 'Bot connected');
  }
  function idTick() {
    var left = Math.max(0, Math.ceil((idEnd - Date.now()) / 1000));
    if (left <= 0) { idExpired(); return; }
    $('idtimer').textContent = 'Expires in ' + fmtLeft(left);
    $('idtimer').classList.toggle('low', left <= 60);
  }
  function idStart(seconds) {
    if (idTimer || seconds <= 0) return;
    idEnd = Date.now() + seconds * 1000;
    $('idtimer').classList.remove('gone', 'low');
    idTick(); idTimer = setInterval(idTick, 1000);
  }

  // copies text and shows a success (gold) or failure state on the button
  function copy(text, btn, labelEl) {
    labelEl = labelEl || btn;
    if (!labelEl._old) labelEl._old = labelEl.textContent;
    var restore = function () { labelEl.textContent = labelEl._old; labelEl._old = null; };
    var ok = function () {
      labelEl.textContent = 'Copied ✓'; flash(btn, 'done', 1800); snd('copy');
      clearTimeout(labelEl._r); labelEl._r = setTimeout(restore, 1800);
    };
    var bad = function () {
      labelEl.textContent = 'Press and hold to copy'; flash(btn, 'fail', 2400); snd('error');
      clearTimeout(labelEl._r); labelEl._r = setTimeout(restore, 2400);
    };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.top = '0'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      try { if (document.execCommand('copy')) ok(); else bad(); } catch (e) { bad(); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
  }

  // the "secure connection" badge only claims what is true
  (function () {
    var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (location.protocol !== 'https:' && !local) {
      $('secure-text').innerHTML = '<span class="long">Connection not secure</span><span class="short">Not secure</span>';
    }
  })();

  // ---------- tabs ----------
  var tabs = $('tabs'), HINT = {
    code: 'Enter your WhatsApp number to generate a one-time pairing code.',
    qr: 'Show a QR code and scan it with WhatsApp. You need a second screen to display it.'
  };
  function setMethod(m, focus) {
    if (submitting) return;                       // never change method while a request is running
    var code = m === 'code', same = m === method;
    method = m;
    $('t-code').classList.toggle('on', code); $('t-qr').classList.toggle('on', !code);
    $('t-code').setAttribute('aria-selected', code); $('t-qr').setAttribute('aria-selected', !code);
    $('t-code').tabIndex = code ? 0 : -1; $('t-qr').tabIndex = code ? -1 : 0;
    tabs.classList.toggle('qr', !code);          // the indicator slides (CSS transition)
    var field = $('numwrap');
    field.classList.toggle('off', !code);
    if (!code) field.setAttribute('inert', ''); else field.removeAttribute('inert');
    field.setAttribute('aria-hidden', code ? 'false' : 'true');
    swapText($('mhint-text'), HINT[m]);
    swapText($('go-text'), code ? 'Generate pairing code' : 'Show QR code');
    if (!same) { setText($('err1'), ''); setText($('numerr'), ''); $('number').removeAttribute('aria-invalid'); }
    if (focus) $(code ? 't-code' : 't-qr').focus();
  }
  $('t-code').addEventListener('click', function () { setMethod('code'); });
  $('t-qr').addEventListener('click', function () { setMethod('qr'); });
  tabs.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setMethod(e.key === 'ArrowLeft' || e.key === 'Home' ? 'code' : 'qr', true);
    }
  });
  // turn the slide animation on only after the first paint, so the page does not animate on load
  requestAnimationFrame(function () { requestAnimationFrame(function () { tabs.classList.add('ready'); }); });

  // ---------- phone number: country, digits left, checks ----------
  var P = window.TFX_PHONE, num = $('number'), iso = '', lastCountry = '';
  // the likely country: the phone's time zone first, then the language region (no tracking, nothing is sent anywhere)
  var TZ = { 'Africa/Lagos': 'NG', 'Africa/Accra': 'GH', 'Africa/Johannesburg': 'ZA', 'Africa/Nairobi': 'KE', 'Africa/Kampala': 'UG', 'Africa/Dar_es_Salaam': 'TZ', 'Africa/Addis_Ababa': 'ET', 'Africa/Kigali': 'RW', 'Africa/Lusaka': 'ZM', 'Africa/Harare': 'ZW', 'Africa/Douala': 'CM', 'Africa/Abidjan': 'CI', 'Africa/Dakar': 'SN', 'Africa/Cairo': 'EG', 'Africa/Casablanca': 'MA', 'Africa/Algiers': 'DZ', 'Africa/Tunis': 'TN', 'Africa/Luanda': 'AO', 'Africa/Maputo': 'MZ', 'Africa/Windhoek': 'NA', 'Africa/Gaborone': 'BW', 'Africa/Khartoum': 'SD', 'Africa/Freetown': 'SL', 'Africa/Monrovia': 'LR', 'Africa/Lome': 'TG', 'Africa/Porto-Novo': 'BJ',
    'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'America/Toronto': 'CA', 'America/Vancouver': 'CA', 'America/Mexico_City': 'MX', 'America/Sao_Paulo': 'BR', 'America/Argentina/Buenos_Aires': 'AR', 'America/Bogota': 'CO', 'America/Santiago': 'CL', 'America/Lima': 'PE', 'America/Caracas': 'VE', 'America/Jamaica': 'JM',
    'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Lisbon': 'PT', 'Europe/Zurich': 'CH', 'Europe/Vienna': 'AT', 'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Helsinki': 'FI', 'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Europe/Athens': 'GR', 'Europe/Istanbul': 'TR', 'Europe/Moscow': 'RU', 'Europe/Kiev': 'UA', 'Europe/Kyiv': 'UA', 'Europe/Bucharest': 'RO',
    'Asia/Kolkata': 'IN', 'Asia/Calcutta': 'IN', 'Asia/Karachi': 'PK', 'Asia/Dhaka': 'BD', 'Asia/Colombo': 'LK', 'Asia/Kathmandu': 'NP', 'Asia/Dubai': 'AE', 'Asia/Riyadh': 'SA', 'Asia/Qatar': 'QA', 'Asia/Kuwait': 'KW', 'Asia/Tehran': 'IR', 'Asia/Baghdad': 'IQ', 'Asia/Amman': 'JO', 'Asia/Beirut': 'LB', 'Asia/Jerusalem': 'IL', 'Asia/Shanghai': 'CN', 'Asia/Hong_Kong': 'HK', 'Asia/Taipei': 'TW', 'Asia/Tokyo': 'JP', 'Asia/Seoul': 'KR', 'Asia/Singapore': 'SG', 'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID', 'Asia/Bangkok': 'TH', 'Asia/Ho_Chi_Minh': 'VN', 'Asia/Manila': 'PH', 'Asia/Almaty': 'KZ', 'Asia/Tashkent': 'UZ', 'Asia/Kabul': 'AF',
    'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Perth': 'AU', 'Australia/Brisbane': 'AU', 'Pacific/Auckland': 'NZ' };
  function detectCountry() {
    try { var z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (z && TZ[z]) return TZ[z]; } catch (e) { /* no Intl */ }
    try { var ls = navigator.languages || [navigator.language]; for (var i = 0; i < ls.length; i++) { var m = /[-_]([A-Za-z]{2})$/.exec(ls[i] || ''); if (m && P.byIso(m[1])) return m[1].toUpperCase(); } } catch (e) { /* no language */ }
    return '';
  }
  function setCountry(code, silent) {
    var c = P.byIso(code); iso = c ? c.iso : '';
    $('cflag').textContent = c ? P.flag(c.iso) : '🌍';
    $('cdial').textContent = c ? '+' + c.dial : '+';
    $('cflag2').textContent = c ? P.flag(c.iso) : '🌍';
    $('cdial2').textContent = c ? '+' + c.dial : '+';
    $('cpick').setAttribute('aria-label', c ? 'Country: ' + c.name + ' +' + c.dial + '. Change' : 'Choose country');
    if (!silent) { showCount(); showCount2(); }
  }
  function lengthText(c) { return c.min === c.max ? c.min + ' digits' : c.min + '–' + c.max + ' digits'; }
  // live state while typing: how many digits are still needed, and whether the number is valid for the country
  function showCount() {
    var box = $('phone'), hint = $('numhint'), out = $('ccount'), c = P.byIso(iso), a = P.analyze(num.value, iso);
    box.classList.remove('bad', 'good'); hint.classList.remove('ok', 'bad');
    if (a.countryChanged && a.countryChanged !== iso) { setCountry(a.countryChanged, true); c = P.byIso(iso); }
    if (!c) { out.textContent = 'Choose your country, then type your number without the country code.'; return a; }
    if (a.state === 'empty') out.textContent = c.name + ' numbers have ' + lengthText(c) + ' (without +' + c.dial + ').';
    else if (a.state === 'incomplete') out.textContent = a.national.length + ' digit' + (a.national.length === 1 ? '' : 's') + ' · ' + a.remaining + ' more needed for ' + c.name + '.';
    else if (a.state === 'toolong') { out.textContent = a.message; hint.classList.add('bad'); box.classList.add('bad'); }
    else if (a.state === 'invalid') { out.textContent = a.message; hint.classList.add('bad'); box.classList.add('bad'); }
    else { out.textContent = '✓ Valid ' + c.name + ' number: +' + a.e164; hint.classList.add('ok'); box.classList.add('good'); }
    return a;
  }
  num.addEventListener('input', function () {
    num.value = num.value.replace(/[^\d\s()+.\-]/g, '');
    // never let the person type past the longest number of the country: extra digits are simply not accepted
    var guard = 0;
    while (guard++ < 40 && num.value && P.analyze(num.value, iso).state === 'toolong') num.value = num.value.slice(0, -1).replace(/[\s().\-]+$/, '');
    var a = showCount();
    // a full international number (+234 801...) turns into the national part once its country is known: the field then shows only what is left to type
    if (/^\s*(\+|00)/.test(num.value) && a.national && P.byIso(iso) && (a.state === 'valid' || a.state === 'incomplete')) {
      num.value = a.national.replace(/(\d{3})(?=\d)/g, '$1 ').replace(/ (\d{1,2})$/, '$1');
      a = showCount();
    }
    if (a.state === 'valid' || a.state === 'incomplete' || a.state === 'empty') { setText($('numerr'), ''); num.removeAttribute('aria-invalid'); }
  });
  // the number the server gets: international digits + the country (the server checks everything again)
  function validNumber() {
    var a = P.analyze(num.value, iso), msg = '';
    if (!iso && a.state !== 'valid') msg = 'Choose your country first.';
    else if (a.state === 'empty') msg = 'Enter your WhatsApp number.';
    else if (a.state === 'incomplete') msg = 'That number is too short for ' + (P.byIso(a.iso) || { name: 'this country' }).name + ': ' + a.remaining + ' more digit' + (a.remaining === 1 ? '' : 's') + ' needed.';
    else if (a.state !== 'valid') msg = a.message || 'That number is not valid for the selected country.';
    if (msg) { setText($('numerr'), msg); num.setAttribute('aria-invalid', 'true'); num.focus(); return null; }
    lastCountry = a.iso;
    return a.e164;
  }

  // ---------- one number or two ----------
  var num2 = $('number2');
  function setDevices(n, silent) {
    devices = n === 2 ? 2 : 1;
    [].forEach.call(document.querySelectorAll('#dsel .dopt'), function (b) {
      var on = Number(b.getAttribute('data-n')) === devices;
      b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    var box = $('numwrap2');
    box.classList.toggle('off', devices !== 2);
    if (devices === 2) { box.removeAttribute('inert'); box.removeAttribute('aria-hidden'); }
    else { box.setAttribute('inert', ''); box.setAttribute('aria-hidden', 'true'); }
    if (!silent) { setText($('numerr2'), ''); showCount2(); }
  }
  [].forEach.call(document.querySelectorAll('#dsel .dopt'), function (b) {
    b.addEventListener('click', function () { if (submitting) return; snd('tap'); setDevices(Number(b.getAttribute('data-n'))); });
  });
  // the second number uses the same country as the first: one picker, two fields
  function showCount2() {
    var box = $('phone2'), hint = $('numhint2'), c = P.byIso(iso), a = P.analyze(num2.value, iso);
    box.classList.remove('bad', 'good'); hint.classList.remove('ok', 'bad');
    if (!c) { hint.textContent = 'Choose the country for the first number first.'; return a; }
    if (a.state === 'empty') hint.textContent = 'The second ' + c.name + ' number, without +' + c.dial + ' (' + lengthText(c) + ').';
    else if (a.state === 'incomplete') hint.textContent = a.national.length + ' digit' + (a.national.length === 1 ? '' : 's') + ' · ' + a.remaining + ' more needed.';
    else if (a.state === 'toolong' || a.state === 'invalid') { hint.textContent = a.message; hint.classList.add('bad'); box.classList.add('bad'); }
    else { hint.textContent = '✓ Valid ' + c.name + ' number: +' + a.e164; hint.classList.add('ok'); box.classList.add('good'); }
    return a;
  }
  num2.addEventListener('input', function () {
    num2.value = num2.value.replace(/[^\d\s()+.\-]/g, '');
    var guard = 0;
    while (guard++ < 40 && num2.value && P.analyze(num2.value, iso).state === 'toolong') num2.value = num2.value.slice(0, -1).replace(/[\s().\-]+$/, '');
    var a = showCount2();
    if (/^\s*(\+|00)/.test(num2.value) && a.national && P.byIso(iso) && (a.state === 'valid' || a.state === 'incomplete')) {
      num2.value = a.national.replace(/(\d{3})(?=\d)/g, '$1 ').replace(/ (\d{1,2})$/, '$1');
      a = showCount2();
    }
    if (a.state === 'valid' || a.state === 'incomplete' || a.state === 'empty') { setText($('numerr2'), ''); num2.removeAttribute('aria-invalid'); }
  });
  function validNumber2() {
    var a = P.analyze(num2.value, iso), msg = '';
    if (!iso && a.state !== 'valid') msg = 'Choose the country for the first number first.';
    else if (a.state === 'empty') msg = 'Enter the second WhatsApp number, or choose 1 number.';
    else if (a.state === 'incomplete') msg = 'That second number is too short for ' + (P.byIso(a.iso) || { name: 'this country' }).name + ': ' + a.remaining + ' more digit' + (a.remaining === 1 ? '' : 's') + ' needed.';
    else if (a.state !== 'valid') msg = a.message || 'That second number is not valid for the selected country.';
    if (msg) { setText($('numerr2'), msg); num2.setAttribute('aria-invalid', 'true'); num2.focus(); return null; }
    return a.e164;
  }
  // country picker (a searchable sheet)
  function fillList(q) {
    var ul = $('cul'), t = String(q || '').trim().toLowerCase().replace(/^\+/, ''), n = 0; ul.innerHTML = '';
    P.COUNTRIES.slice().sort(function (x, y) { return x.name.localeCompare(y.name); }).forEach(function (c) {
      if (t && c.name.toLowerCase().indexOf(t) < 0 && c.dial.indexOf(t) !== 0 && c.iso.toLowerCase() !== t) return;
      var li = document.createElement('li'); li.setAttribute('role', 'option'); li.setAttribute('data-iso', c.iso); li.setAttribute('aria-selected', c.iso === iso ? 'true' : 'false'); li.tabIndex = 0;
      var f = document.createElement('span'); f.className = 'cflag'; f.textContent = P.flag(c.iso);
      var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name;
      var dl = document.createElement('span'); dl.className = 'dl'; dl.textContent = '+' + c.dial;
      li.appendChild(f); li.appendChild(nm); li.appendChild(dl); ul.appendChild(li); n++;
    });
    if (!n) { var no = document.createElement('li'); no.className = 'none'; no.textContent = 'No country found'; ul.appendChild(no); }
  }
  function sheet(open) {
    $('csheet').hidden = !open; $('cpick').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { $('csearch').value = ''; fillList(''); setTimeout(function () { $('csearch').focus(); var s = $('cul').querySelector('[aria-selected="true"]'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'center' }); }, 30); }
    else $('cpick').focus();
  }
  $('cpick').addEventListener('click', function () { if (!submitting) sheet(true); });
  $('csheet-bg').addEventListener('click', function () { sheet(false); });
  $('csheet-x').addEventListener('click', function () { sheet(false); });
  $('csearch').addEventListener('input', function () { fillList(this.value); });
  function pick(li) { if (!li || !li.getAttribute('data-iso')) return; setCountry(li.getAttribute('data-iso')); sheet(false); num.focus(); }
  $('cul').addEventListener('click', function (e) { pick(e.target.closest('li')); });
  $('cul').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e.target.closest('li')); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('csheet').hidden) sheet(false); });
  setCountry(detectCountry(), true); showCount();

  // ---------- code cells ----------
  function renderCode(code) {
    var row = $('code'); row.innerHTML = '';
    var clean = String(code || '').replace(/[^A-Za-z0-9]/g, '');
    var shown = clean || '········';
    row.classList.toggle('wait', !clean);
    for (var i = 0; i < 8; i++) {
      if (i === 4) { var d = document.createElement('span'); d.className = 'dash'; d.textContent = '–'; d.setAttribute('aria-hidden', 'true'); row.appendChild(d); }
      var c = document.createElement('span'); c.className = 'ch'; c.style.setProperty('--i', i);
      c.textContent = clean ? shown.charAt(i) : '•';
      row.appendChild(c);
    }
    row.setAttribute('aria-label', clean ? 'Pairing code ' + clean.split('').join(' ') : 'Pairing code is being generated');
  }

  // ---------- start ----------
  function reset() {
    $('connect').classList.remove('ldb', 'ldx');
    stop(); idStop(); clearJob(); restoring = false; slowPoll = false; islandReset();
    $('step-done').classList.remove('used'); $('usedmsg').hidden = true; $('idtimer').classList.remove('used'); job = null; batch = null; ids = []; lastCode = ''; dmPolls = 0; submitting = false; reqId++; checking = false;
    renderCode(''); $('code').hidden = false; $('codemsg').hidden = true; $('qrmsg').hidden = true; $('retry').hidden = true; $('retry').disabled = false; $('retry-text').textContent = 'Try again'; $('status').parentNode.classList.remove('done');
    $('qrimg').hidden = true; $('qrimg').removeAttribute('src'); $('qrskel').hidden = false;
    $('copycode').disabled = true;
    $('prog').style.width = '100%'; $('timer').hidden = true;
    setText($('err1'), ''); setText($('err2'), ''); setText($('numerr2'), ''); num2.removeAttribute('aria-invalid');
    $('phone2').classList.remove('bad', 'good'); $('numhint2').classList.remove('ok', 'bad'); showCount2();
    busy(false);
    $('sid').hidden = false; $('sid').classList.remove('expired'); $('sid').removeAttribute('aria-disabled'); $('sid').tabIndex = 0;
    $('sidlist').hidden = true; $('sidlist').innerHTML = ''; $('sidlist').removeAttribute('data-ids');
    $('copy').hidden = false; $('copy').disabled = false; $('copyenv').disabled = false; $('idtimer').textContent = ''; $('idtimer').classList.remove('gone', 'low');
    $('dl').hidden = true; $('dl').removeAttribute('href'); $('dlwait').hidden = false; $('dlwait').textContent = 'Building your index.js…';
    show('step-number');
  }
  function busy(on) {
    var b = $('go'); b.classList.toggle('busy', on); b.setAttribute('aria-busy', on ? 'true' : 'false'); b.disabled = on;
    $('connect').classList.toggle('ldb', on); if (on) $('connect').classList.remove('ldx');   // the phone and 5AFFUL picture shows "connecting" while the request runs
    tabs.classList.toggle('locked', on); $('number').readOnly = on; $('number2').readOnly = on; $('cpick').disabled = on;
    [].forEach.call(document.querySelectorAll('#dsel .dopt'), function (o) { o.disabled = on; });
  }
  function idleLabel() { swapText($('go-text'), method === 'code' ? 'Generate pairing code' : 'Show QR code'); }
  function failSubmit(msg) {
    submitting = false; busy(false); idleLabel(); $('connect').classList.add('ldx');
    islandSet('bad', 'Could not start. Try again.');
    setText($('err1'), msg); flash($('go'), 'shake', 500); $('go').classList.add('fail');
    try { $('err1').scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' }); } catch (e) { /* older browsers */ }
    setTimeout(function () { $('go').classList.remove('fail'); }, 2400);
  }

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitting) return;                       // a request is already running: ignore repeated taps and Enter
    setText($('err1'), '');
    var number = '';
    if (method === 'code') { number = validNumber(); if (!number) { flash($('go'), 'shake', 500); return; } }
    var number2 = '';
    if (method === 'code' && devices === 2) {
      number2 = validNumber2();
      if (!number2) { flash($('go'), 'shake', 500); return; }
      if (number2 === number) { setText($('numerr2'), 'That is the same number twice. Use a different number for the second one.'); num2.setAttribute('aria-invalid', 'true'); num2.focus(); flash($('go'), 'shake', 500); return; }
    }
    submitting = true; var mine = ++reqId, sent = method; lastNumber = number; lastNumber2 = number2;
    busy(true);
    snd('press'); islLock = false; islandSet('working', 'Connecting…');
    swapText($('go-text'), sent === 'code' ? 'Generating…' : 'Preparing…');
    TFLoad.fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: sent, number: number, number2: number2, devices: devices, country: lastCountry }) }, 25000)
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); })
      .then(function (x) {
        if (mine !== reqId) return;
        if (!x.ok) return failSubmit(x.j.error || 'Something went wrong. Please try again.');
        submitting = false;
        job = x.j.job; batch = x.j.batch || null; dmPolls = 0; saveJob();
        $('pane-code').hidden = method !== 'code'; $('pane-qr').hidden = method !== 'qr';
        $('status').textContent = method === 'code' ? 'Requesting your pairing code…' : 'Preparing your QR code…';
        renderCode(''); $('qrimg').hidden = true; $('qrskel').hidden = false;
        busy(false); idleLabel();
        show('step-wait');
        poll = setInterval(check, 2000); check();
      })
      .catch(function (e) { if (mine === reqId) failSubmit(e && e.timeout ? 'The site is taking too long to answer. Please try again.' : 'Could not reach the site. Check your internet connection and try again.'); });
  });

  // an attempt ended (expired, refused, stopped): no empty box - say what happened and offer "Try again"
  function ended(msg) {
    var qr = method === 'qr';
    renderCode(''); lastCode = ''; $('copycode').disabled = true; $('qrimg').hidden = true; $('qrskel').hidden = true;
    $('code').hidden = true;
    setText($('codemsg'), 'This code has expired or stopped. Press Try again to get a new one.');
    setText($('qrmsg'), 'This QR code has expired or stopped. Press Try again to get a new one.');
    $('codemsg').hidden = qr; $('qrmsg').hidden = !qr;
    $('timer').hidden = true; $('prog').style.width = '0%';
    $('status').textContent = 'This attempt ended.'; $('status').parentNode.classList.add('done');
    $('retry-text').textContent = qr ? 'Try again – new QR code' : 'Try again – new code';
    $('retry').classList.add('main'); $('retry').hidden = false; $('retry').disabled = false;
    setText($('err2'), msg || '');
    islandSet('bad', 'Linking failed'); $('connect').classList.remove('ldb'); $('connect').classList.add('ldx');
  }
  // "Try again": drop the old attempt and ask for a new code / QR right here (same number, same screen).
  // With two numbers it only starts the number that failed again: the one already linked keeps its login.
  function retry() {
    if (submitting) return;
    stop(); var old = batch; submitting = true; var mine = ++reqId, sent = method;
    snd('press'); islLock = false; islandSet('working', 'Connecting…'); $('connect').classList.remove('ldx');
    $('status').parentNode.classList.remove('done'); $('retry').disabled = true; $('retry-text').textContent = 'Getting a new one…';
    setText($('err2'), ''); $('codemsg').hidden = true; $('qrmsg').hidden = true; $('code').hidden = false; $('retry').classList.remove('main');
    renderCode(''); lastCode = ''; $('copycode').disabled = true; $('qrimg').hidden = true; $('qrimg').removeAttribute('src'); $('qrskel').hidden = false;
    $('prog').style.width = '100%'; $('timer').hidden = true;
    $('status').textContent = sent === 'code' ? 'Requesting a new pairing code…' : 'Preparing a new QR code…';

    var done = function (x) {
      if (mine !== reqId) return;
      submitting = false; $('retry').disabled = false; $('retry-text').textContent = 'Try again';
      if (!x.ok) { ended((x.j && x.j.error) || 'Something went wrong. Please try again.'); return; }
      $('retry').hidden = true; slowPoll = false;
      poll = setInterval(check, 2000); check();
    };
    var failed = function (e) {
      if (mine !== reqId) return;
      submitting = false; $('retry').disabled = false; $('retry-text').textContent = 'Try again';
      ended(e && e.timeout ? 'The site is taking too long to answer. Please try again.' : 'Could not reach the site. Check your internet connection and try again.');
    };
    var read = function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; }); };

    if (old) {
      fetch('/api/batch/' + old + '/retry', { method: 'POST' }).then(read).then(done, failed);
      return;
    }
    if (job) fetch('/api/cancel/' + job, { method: 'POST' }).catch(function () {});
    clearJob(); job = null; checking = false;
    TFLoad.fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: sent, number: lastNumber, number2: lastNumber2, devices: devices, country: lastCountry }) }, 25000)
      .then(read).then(function (x) {
        if (mine !== reqId) return;
        if (x.ok) { job = x.j.job; batch = x.j.batch || null; dmPolls = 0; saveJob(); }
        done(x);
      }, failed);
  }
  $('retry').addEventListener('click', retry);

  // ---------- progress ----------
  function pollUrl() { return batch ? '/api/batch/' + batch : '/api/job/' + job; }

  // a batch answers with slots; an attempt started before this page was updated
  // only has the old single-job answer. Both become the same shape here.
  function normalize(x) {
    if (!x || !x.state) return x || null;
    if (x.slots) return x;
    var slot = { index: 0, number: lastNumber, state: x.state };
    ['code', 'qr', 'note', 'error', 'secondsLeft', 'dm'].forEach(function (k) { if (x[k] != null) slot[k] = x[k]; });
    if (x.state === 'linked') slot.sessionId = x.sessionId;
    return {
      state: x.state, devices: 1, slot: 0, slots: [slot],
      sessionIds: x.state === 'linked' && x.sessionId ? [x.sessionId] : [],
      idSecondsLeft: x.idSecondsLeft, expired: x.expired, dm: x.dm, error: x.error
    };
  }

  function check() {
    if ((!job && !batch) || checking) return;
    checking = true; var mine = batch || job;
    fetch(pollUrl()).then(function (r) { return r.json(); }).then(function (raw) {
      checking = false;
      if ((batch || job) !== mine) return;
      var b = normalize(raw);
      if (!b || !b.state) {
        stop();
        if (restoring) { restoring = false; return reset(); }
        clearJob(); return ended(raw && raw.error ? raw.error : 'This attempt is no longer available.');
      }
      restoring = false;
      paint(b);
    }).catch(function () { checking = false; /* keep trying */ });
  }

  function paint(b) {
    var slots = b.slots || [];
    var active = slots[b.slot] || slots[0] || { state: b.state };
    var two = (b.devices || 1) > 1;
    var linked = 0;
    for (var i = 0; i < slots.length; i++) if (slots[i].state === 'linked') linked++;

    if ((active.state === 'code' || active.state === 'linking') && active.code && active.code !== lastCode) {
      lastCode = active.code; renderCode(active.code); $('copycode').disabled = false;
    }
    if (active.state === 'qr' && active.qr) {
      if ($('qrimg').getAttribute('src') !== active.qr) $('qrimg').src = active.qr;
      $('qrimg').hidden = false; $('qrskel').hidden = true;
    }

    $('retry').hidden = !(active.state === 'code' || active.state === 'qr' || b.state === 'failed');

    if (b.state === 'ready') { if ($('step-done').hidden) show('step-done'); paintDone(b); return; }

    if (b.state === 'failed') {
      stop();
      if (two && linked === 1) {                 // number 1 is in, only number 2 failed: keep the screen
        setText($('err2'), b.error || '');
        $('status').textContent = 'Number 1 is linked. Number 2 failed — press Try again.';
        $('status').parentNode.classList.add('done');
        $('retry').hidden = false; $('retry').classList.add('main'); $('retry-text').textContent = 'Try again — number 2';
        $('timer').hidden = true; $('prog').style.width = '0%';
        islandSet('bad', 'Number 2 failed'); $('connect').classList.remove('ldb'); $('connect').classList.add('ldx');
        return;
      }
      clearJob();
      return ended(b.error);
    }

    var n = (b.slot || 0) + 1;
    var who = two ? (linked === 1 ? 'Number 1 linked ✓ · Number 2 of 2 — ' : 'Number ' + n + ' of 2 — ') : '';
    var text = {
      starting: method === 'code' ? 'Requesting your pairing code…' : 'Preparing your QR code…',
      code: 'Waiting for you to enter the code in WhatsApp…',
      qr: 'Waiting for you to scan the QR code…',
      linking: 'Accepted. Finishing the link — keep WhatsApp open…'
    };
    if (text[b.state]) $('status').textContent = who + text[b.state];
    $('status').parentNode.classList.remove('done');
    setText($('err2'), '');
    $('retry').classList.remove('main');
    if (!two) $('retry-text').textContent = 'Try again';
    if (b.state === 'linking') { $('qrimg').hidden = true; $('qrskel').hidden = false; }

    if (b.state === 'starting') islandSet('working', two ? 'Connecting number ' + n + '…' : (method === 'code' ? 'Requesting your code…' : 'Preparing your QR…'));
    if (b.state === 'code') islandSet('working', 'Enter the code in WhatsApp');
    if (b.state === 'qr') islandSet('working', 'Scan the QR code');
    if (b.state === 'linking') islandSet('working', 'Linking your account…');

    var left = typeof active.secondsLeft === 'number' ? Math.max(0, active.secondsLeft) : 0;
    $('prog').style.width = Math.min(100, (left / MAX_SECONDS) * 100) + '%';
    $('timer').hidden = false;
    $('timer').textContent = 'This attempt expires in ' + Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2);
  }

  // the IDs and the index.js that already has them inside it
  function paintDone(b) {
    ids = (b.sessionIds || []).slice(0, 2);
    if (b.expired || !ids.length) { idExpired(); return; }

    if (ids.length > 1) {
      $('sid').hidden = true; $('sidlist').hidden = false; $('copy').hidden = true;
      if ($('sidlist').getAttribute('data-ids') !== ids.join(',')) {
        $('sidlist').setAttribute('data-ids', ids.join(','));
        $('sidlist').innerHTML = '';
        ids.forEach(function (id, k) {
          var row = document.createElement('div'); row.className = 'sidrow';
          var who = document.createElement('span'); who.className = 'who';
          who.textContent = k === 0 ? 'Main bot — number 1' : 'Second bot — number 2';
          var box = document.createElement('div'); box.className = 'sid';
          box.setAttribute('role', 'button'); box.tabIndex = 0; box.textContent = id;
          box.setAttribute('aria-label', 'Session ID ' + (k + 1) + '. Tap to copy');
          box.addEventListener('click', function () { copy(id, box, box); flash(box, 'done', 1200); });
          box.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); box.click(); } });
          row.appendChild(who); row.appendChild(box); $('sidlist').appendChild(row);
        });
      }
      $('env').textContent = ids.map(function (id, k) { return (k === 0 ? 'SESSION_ID=' : 'account2=') + id; }).join('\n');
    } else {
      $('sid').hidden = false; $('sidlist').hidden = true; $('copy').hidden = false;
      $('sid').textContent = ids[0];
      $('env').textContent = 'SESSION_ID=' + ids[0];
    }

    var url = b.bundle || ('/api/bundle/' + batch + '/index.js');
    if ($('dl').getAttribute('href') !== url) $('dl').setAttribute('href', url);
    $('dl').hidden = false;
    $('dlwait').hidden = true;
    $('dlhint').textContent = ids.length > 1
      ? 'This file already has both session IDs inside it. Upload it on a fresh panel, start it, and both bots log in by themselves.'
      : 'This file already has your session ID inside it. Upload it on a fresh panel, start it, and the bot logs in by itself.';

    dmNote(b.dm);
    dmPolls++;
    idStart(b.idSecondsLeft);
    // keep watching (more slowly) so the countdown and the expiry stay right
    if (!slowPoll) { slowPoll = true; stop(); poll = setInterval(check, 4000); }
  }

  function dmNote(dm) {
    if (ids.length > 1) {
      $('dm').textContent = dm === true ? 'A copy of each ID was also sent to that WhatsApp (in your own chat).'
        : dm === false ? 'We could not message you on WhatsApp, so copy the IDs from here.'
        : 'Sending a copy to your WhatsApp…';
      return;
    }
    $('dm').textContent = dm === true ? 'A copy was also sent to your WhatsApp (in your own chat).'
      : dm === false ? 'We could not message you on WhatsApp, so copy the ID from here.'
      : 'Sending a copy to your WhatsApp…';
  }

  $('cancel').addEventListener('click', function () { var old = batch || job; if (old) fetch('/api/cancel/' + old, { method: 'POST' }).catch(function () {}); reset(); });
  $('again').addEventListener('click', reset);
  $('copycode').addEventListener('click', function () { if (lastCode) copy(lastCode.replace(/-/g, ''), $('copycode'), $('copycode').querySelector('span')); });
  $('copy').addEventListener('click', function () { copy($('sid').textContent, $('copy'), $('copy-text')); });
  $('copyenv').addEventListener('click', function () { copy($('env').textContent, $('copyenv'), $('copyenv').querySelector('span')); });
  $('sid').addEventListener('click', function () { if ($('sid').classList.contains('expired')) return; copy($('sid').textContent, $('copy'), $('copy-text')); flash($('sid'), 'done', 1200); });
  $('sid').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('sid').click(); } });
  renderCode('');

  // opening or refreshing the page: an unfinished attempt is picked up and shown; otherwise the page starts at the top
  try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (e) { /* fine */ }
  (function () {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(JOBKEY) || 'null'); } catch (e) { saved = null; }
    var savedId = saved && (saved.batch || saved.job);
    if (saved && typeof savedId === 'string' && /^[\w-]{4,64}$/.test(savedId)) {
      job = saved.job || null; batch = saved.batch || null; restoring = true;
      setDevices(saved.devices === 2 ? 2 : 1, true);
      setMethod(saved.method === 'qr' ? 'qr' : 'code');
      $('pane-code').hidden = method !== 'code'; $('pane-qr').hidden = method !== 'qr';
      $('status').textContent = 'Picking up where you left off…';
      idleLabel();
      show('step-wait');
      poll = setInterval(check, 2000); check();
      // an unfinished attempt: refreshing brings you straight back to it
      toConnect(false); var y0 = window.pageYOffset;
      window.addEventListener('load', function () { if (Math.abs(window.pageYOffset - y0) < 4) toConnect(false); });
    } else if (!location.hash) window.scrollTo(0, 0);   // nothing unfinished: opening or refreshing starts at the top
  })();

  // hero picture: stays empty until the picture of the current theme is decoded, then fades in once (no flash of the other theme's picture)
  (function () {
    var done = false;
    function reveal() {
      if (done) return; done = true;
      root.classList.add('art-fade'); root.classList.remove('art-wait');
      setTimeout(function () { root.classList.remove('art-fade'); }, 600);
    }
    var img = document.querySelector('.art-' + (root.getAttribute('data-theme') === 'light' ? 'light' : 'dark'));
    if (!img) return reveal();
    setTimeout(reveal, 1800);                             // slow network: do not wait for ever
    if (img.complete && img.naturalWidth) return reveal();
    if (img.decode) img.decode().then(reveal, reveal); else img.addEventListener('load', reveal);
  })();

  // FAQ: topic tabs (Linking / Safety / Problems); opening one question closes the one that was open
  (function () {
    var list = $('faq-list'); if (!list) return;
    list.addEventListener('toggle', function (e) {
      var d = e.target; if (!d || !d.open || !d.classList.contains('qa')) return;
      [].forEach.call(list.querySelectorAll('details.qa[open]'), function (o) { if (o !== d) o.open = false; });
    }, true);
    var tabs = [].slice.call(document.querySelectorAll('.ftab'));
    function show(i, focus) {
      tabs.forEach(function (t, k) {
        var on = k === i, p = $(t.getAttribute('aria-controls'));
        t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); t.tabIndex = on ? 0 : -1;
        if (p) { p.hidden = !on; if (!on) [].forEach.call(p.querySelectorAll('details.qa[open]'), function (o) { o.open = false; }); }
      });
      if (focus) tabs[i].focus();
    }
    tabs.forEach(function (t, k) {
      t.addEventListener('click', function () { if (!t.classList.contains('on')) { snd('tab'); show(k); } });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); var n = (k + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; snd('tab'); show(n, true); }
      });
    });
  })();

  $('yr').textContent = new Date().getFullYear();
})();
